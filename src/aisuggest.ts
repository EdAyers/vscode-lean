/* Code for getting suggestions from the openAI GPT3 model. */

import { text } from "express";
import { CancellationToken, CodeAction, CodeActionContext, CodeActionProvider, Command, commands, Disposable, languages, ProviderResult, Range, Selection, SnippetString, TextDocument, TextEditor, window } from "vscode";
import { InfoProvider } from "./infoview";
import { Server } from './server';
import * as child from 'child_process';
import * as util from 'util';

const exec = util.promisify(child.exec);

export class AISuggestionProvider implements Disposable {

    constructor(private server: Server) {
        const commandHandler = async (textEditor: TextEditor) => {
            const fileName = textEditor.document.fileName;
            const pos = textEditor.selection.active;
            // ①: grab the goal state using the server.
            const info = await this.server.info(fileName, pos.line + 1, pos.character);
            const goal = info?.record?.state;
            // ②: do some string processing
            let asms : any = goal.split("\n");
            let [g] = asms.splice(asms.length - 1)
            asms = asms.join("\\t");
            let input = `[LN] GOAL ${asms} ${g} PROOFSTEP`;

            // ③: ask GPT3
            const executable = "~/.local/bin/openai"
            const OPEN_AI_KEY = process.env['OPEN_AI_KEY'];
            const args = [
                "-o", "openai-formal-external",
                "-k", OPEN_AI_KEY,
                "api", "engines.generate",
                "-i", "formal-small-lean-webmath-1208-v3-1-c4",
                "-l", "256",
                "-c", "\"" + input + "\"",
            ]
            const command = executable + " " + args.join(" ");
            window.showInformationMessage(`Sending: ${input}`);
            const {stdout, stderr} = await exec(command);
            const results = stdout.split(input + " ");
            const result = results[results.length - 1]

            // ④ Do the edit!
            textEditor.insertSnippet(new SnippetString(result + ",\n"));

        }
        this.subscriptions.push(
            commands.registerTextEditorCommand('lean.AIsuggestion', commandHandler),
        );
    }

    private subscriptions : Disposable[] = [];

    dispose() {
        this.subscriptions.forEach(x => x.dispose());
    }


}