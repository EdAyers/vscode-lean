import {
    CancellationToken, commands, Disposable, DocumentFilter, Hover,
    HoverProvider, languages, Position, Range, Selection, TextDocument,
    TextDocumentChangeEvent, TextEditor, TextEditorDecorationType,
    TextEditorSelectionChangeEvent, window, workspace,
} from 'vscode';

export interface Translations { [abbrev: string]: string; }

function inputModeEnabled(): boolean {
    return workspace.getConfiguration('lean.input').get('enabled', true);
}

function inputModeLeader(): string {
    return workspace.getConfiguration('lean.input').get('leader', '\\');
}

export function inputModeLanguages(): string[] {
    return workspace.getConfiguration('lean.input').get('languages', ['lean']);
}

function inputModeCustomTranslations(): Translations {
    return workspace.getConfiguration('lean.input').get('customTranslations', {});
}

/** Adds hover behaviour for getting translations of unicode characters. Eg: "Type ⊓ using \glb or \sqcap"  */
export class LeanInputExplanationHover implements HoverProvider, Disposable {
    private leader = inputModeLeader();
    private customTranslations = inputModeCustomTranslations();
    private subscriptions: Disposable[] = [];

    constructor(private translations: Translations) {
        this.subscriptions.push(
            workspace.onDidChangeConfiguration(() => {
                this.leader = inputModeLeader();
                this.customTranslations = inputModeCustomTranslations();
            }));
    }

    getAbbrevations(symbol: string): string[] {
        const abbrevs: string[] = [];
        for (const k in this.customTranslations) {
            if (this.customTranslations[k] === symbol) { abbrevs.push(k); }
        }
        for (const k in this.translations) {
            if (this.customTranslations[k]) { continue; }
            if (this.translations[k] === symbol) { abbrevs.push(k); }
        }
        return abbrevs;
    }

    provideHover(document: TextDocument, pos: Position, token: CancellationToken): Hover | undefined {
        const symbolRange = new Range(pos, pos.translate(0, 1));
        const symbol = document.getText(symbolRange);
        const abbrevs = this.getAbbrevations(symbol).sort((a, b) => a.length - b.length);
        return abbrevs.length > 0 &&
            new Hover(`Type ${symbol} using ${abbrevs.map((a) => this.leader + a).join(' or ')}`, symbolRange);
    }

    dispose() {
        for (const s of this.subscriptions) { s.dispose(); }
    }
}
function rangeSize(r: Range): number {
    return r.end.character - r.start.character;
}

interface RangeInfo {
    index: number;
    selection: Selection;
    range: Range;
    text: string;
}

/* Each editor has their own abbreviation handler. */
class TextEditorAbbrevHandler {
    active = false;

    constructor(public editor: TextEditor, private abbreviator: LeanInputAbbreviator) { }
    get leader(): string { return this.abbreviator.leader; }
    get enabled(): boolean { return this.abbreviator.enabled; }

    private deactivate() {
        this.active = false;
        this.editor.setDecorations(this.abbreviator.decorationType, []);
    }

    private getRangeInfo(incrCursor = 0): RangeInfo[] {
        if (!this.active) { return []; }
        const selections = this.editor.selections;
        if (selections.some((s) => !s.isSingleLine || !s.isEmpty)) { return []; }
        const ranges: RangeInfo[] = [];
        for (let i = 0; i < selections.length; i++) {
            const selection = selections[i];
            const line = selection.active.line;
            const character = selection.active.character + incrCursor;
            const beforeCursor = this.editor.document.getText(new Range(line, 0, line, character));
            const r = /\\\S*?$/.exec(beforeCursor);
            if (!r) { continue; }
            const s = r[0];
            ranges.push({
                index: i,
                selection,
                range: new Range(line, character - s.length, line, character),
                text: s,
            });
        }
        return ranges;
    }

    private update(incrCursor = 0): void {
        const ris = this.getRangeInfo(incrCursor);
        if (ris.length === 0) { return this.deactivate(); }
        const hackyReplacements: { [input: string]: {repl: string,right?: string} } = {
            [this.leader + '{{']: {repl:'⦃⦄',right : '}}'},
            [this.leader + '[[']: {repl:'⟦⟧',right:']]'},
            [this.leader + '<>']: {repl:'⟨⟩'},
        };
        const replacements = [];
        for (let i = 0; i < ris.length; i++) { // tslint:disable-line
            const ri = ris[i];
            const replacement = hackyReplacements[ri.text];
            if (replacement) {
                const {repl,right} = replacement;
                if (right) {
                    const t = this.editor.document.getText(
                        new Range(ri.range.end, ri.range.end.translate(0,right.length)));
                    if (t !== right) {continue;}
                }
                const pos = ri.range.start.translate(0, 1);
                const range = new Range(ri.range.start, ri.range.end.translate(0,(right && right.length) || 0));
                replacements.push([ri.index, range, repl, pos]);
                ris[i].text = '';
                ris[i].range = new Range(pos, pos);
            }
        }
        if (replacements.length !== 0) {
            this.editor.edit(async (builder) => {
                const ss = [...this.editor.selections];
                for (const [i, range, repl, pos] of replacements) {
                    builder.replace(range, repl);
                    ss[i] = new Selection(pos,pos);
                }
                this.editor.selections = ss;
            });
        }
        this.editor.setDecorations(this.abbreviator.decorationType, ris.map((x) => x.range));

    }
    convert(): void {
        const ris = this.getRangeInfo();
        if (ris.length === 0) { return this.deactivate(); }
        const replacements: Array<[Range, string]> = [];
        for (const { range, text } of ris) {
            if (rangeSize(range) < 2) { continue; }
            const abbreviation = text.slice(1);
            const replacement = this.abbreviator.findReplacement(abbreviation);
            replacements.push([range, replacement]);
        }
        if (replacements.length !== 0) {
            setTimeout(async () => {
                await this.editor.edit((builder) => {
                    replacements.forEach(([range, repl]) => builder.replace(range, repl));
                });
            }, 0);
        }
        this.deactivate();
    }

    onChanged(ev: TextDocumentChangeEvent) {
        if (ev.contentChanges.length === 0) {
            // This event is triggered by files.autoSave=onDelay
            return;
        }
        const change = ev.contentChanges[0];
        if (!this.active) {
            if (change.text === this.leader) {
                this.active = true;
                return this.update(1);
            } else {
                return;
            }
        } else {
            if (change.text === this.leader) {
                this.convert();
                this.active = true;
                return this.update();
            } else if (change.text.match(/^\s+|[^{(]?[)}⟩]$/)) {
                return this.convert();
            } else if (change.text === '') { // a backspace occurred
                return this.update(-1);
            } else {
                return this.update(change.text.length);
            }
        }
    }

    onSelectionChanged(ev: TextEditorSelectionChangeEvent) {
        return this.update();
    }
}

export class LeanInputAbbreviator {
    private subscriptions: Disposable[] = [];
    leader = inputModeLeader();
    enabled = inputModeEnabled();
    languages = inputModeLanguages();
    customTranslations = inputModeCustomTranslations();
    allTranslations: Translations;

    private handlers = new Map<TextEditor, TextEditorAbbrevHandler>();

    decorationType: TextEditorDecorationType;

    constructor(private translations: Translations) {
        this.translations = Object.assign({}, translations);
        this.allTranslations = { ...this.translations, ...this.customTranslations };

        this.decorationType = window.createTextEditorDecorationType({
            textDecoration: 'underline',
        });

        this.subscriptions.push(workspace.onDidChangeTextDocument((ev) => this.onChanged(ev)));
        this.subscriptions.push(window.onDidChangeTextEditorSelection((ev) => this.onSelectionChanged(ev)));

        this.subscriptions.push(window.onDidChangeVisibleTextEditors((editors) => {
            // delete removed editors
            const handlers = new Map<TextEditor, TextEditorAbbrevHandler>();
            this.handlers.forEach((h, e) => {
                if (editors.indexOf(e) !== -1) {
                    handlers.set(e, h);
                }
            });
            this.handlers = handlers;
        }));

        this.subscriptions.push(window.onDidChangeActiveTextEditor(() => this.updateInputActive()));

        this.subscriptions.push(commands.registerTextEditorCommand('lean.input.convert', (editor, edit) => {
            const handler = this.handlers.get(editor);
            if (handler) {
                handler.convert();
            }
        }));

        this.subscriptions.push(workspace.onDidChangeConfiguration(() => {
            this.leader = inputModeLeader();
            this.enabled = inputModeEnabled();
            this.languages = inputModeLanguages();
            this.customTranslations = inputModeCustomTranslations();
            this.allTranslations = { ...this.translations, ...this.customTranslations };
        }));
    }

    private setInputActive(isActive: boolean) {
        commands.executeCommand('setContext', 'lean.input.isActive', isActive);
    }

    get active(): boolean {
        const handler = this.handlers.get(window.activeTextEditor);
        return handler && handler.active;
    }

    updateInputActive() {
        this.setInputActive(this.active);
    }

    findReplacement(typedAbbrev: string): string | undefined {
        if (typedAbbrev === '') { return undefined; }

        if (this.allTranslations[typedAbbrev]) { return this.allTranslations[typedAbbrev]; }

        let shortestExtension: string = null;
        for (const abbrev in this.allTranslations) {
            if (abbrev.startsWith(typedAbbrev) && (!shortestExtension || abbrev.length < shortestExtension.length)) {
                shortestExtension = abbrev;
            }
        }

        if (shortestExtension) {
            return this.allTranslations[shortestExtension];
        } else if (typedAbbrev) {
            const prefixReplacement = this.findReplacement(
                typedAbbrev.slice(0, typedAbbrev.length - 1));
            if (prefixReplacement) {
                return prefixReplacement + typedAbbrev.slice(typedAbbrev.length - 1);
            }
        }
        return null;
    }

    private isSupportedFile(document: TextDocument) {
        return !!languages.match(this.languages, document);
    }

    private onChanged(ev: TextDocumentChangeEvent) {
        const editor = window.activeTextEditor;

        if (editor.document !== ev.document) { return; } // change happened in active editor

        if (!this.isSupportedFile(ev.document)) { return; } // Not a supported file

        if (!this.handlers.has(editor)) {
            this.handlers.set(editor, new TextEditorAbbrevHandler(editor, this));
        }
        this.handlers.get(editor).onChanged(ev);
    }

    private onSelectionChanged(ev: TextEditorSelectionChangeEvent) {
        const editor = window.activeTextEditor;

        if (editor !== ev.textEditor) { return; } // change happened in active editor

        if (!this.isSupportedFile(editor.document)) { return; } // Lean file

        if (this.handlers.has(editor)) {
            this.handlers.get(editor).onSelectionChanged(ev);
        }
    }

    dispose() {
        this.decorationType.dispose();
        for (const s of this.subscriptions) {
            s.dispose();
        }
    }
}
