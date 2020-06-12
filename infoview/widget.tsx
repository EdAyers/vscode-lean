import * as React from 'react';
import * as ReactPopper from 'react-popper';
import './popper.css';
import { WidgetData, WidgetComponent, WidgetHtml, WidgetElement, WidgetEventRequest } from 'lean-client-js-node';

const Popper = (props) => {
    const { children, popperContent, refEltTag, refEltAttrs } = props;
    const [referenceElement, setReferenceElement] = React.useState(null);
    const [popperElement, setPopperElement] = React.useState(null);
    const [arrowElement, setArrowElement] = React.useState(null);
    const { styles, attributes } = ReactPopper.usePopper(referenceElement, popperElement, {
        modifiers: [
            { name: 'arrow', options: { element: arrowElement } },
            { name: 'offset', options: { offset: [0, 8] } }
        ],
    });
    const refElt = React.createElement(refEltTag, { ref: setReferenceElement, ...refEltAttrs }, children);
    return (
        <>
            {refElt}
            <div ref={setPopperElement} style={styles.popper} {...attributes.popper} className="tooltip">
                {popperContent}
                <div ref={setArrowElement} style={styles.arrow} className="arrow" />
            </div>
        </>
    );
}

export interface WidgetProps {
    widget?: WidgetData;
    post: (e: WidgetEventRequest) => void;
}

class WidgetErrorBoundary extends React.Component<{children},{error}> {
    constructor(props) {
      super(props);
      this.state = { error: null };
    }
    static getDerivedStateFromError(error) {
        return { error };
    }
    componentDidCatch(error, errorInfo) {
        console.log(error, errorInfo);
    }
    componentWillReceiveProps(new_props) {
        this.setState({error: null});
    }
    render() {
      if (this.state.error) {
        const message = this.state.error.message
        return <div className="ba b--red pa3">
            <h1>Widget rendering threw an error:</h1>
            {message}
        </div>;
      }
      return this.props.children;
    }
}

function arraysEq(a1 : number[], a2 : number[]) {
    if (a1.length !== a2.length) {return false;}
    for (let i = 0; i < a1.length; i++) {
        if (a1[i] !== a2[i]) {return false;}
    }
    return true;
}

export function Widget(props: WidgetProps): JSX.Element {
    if (!props.widget) { return null; }
    const [mouseRoute, setMouseRoute] = React.useState([]);
    const globalMouse = (r) => {
        if (arraysEq(r, mouseRoute)) {return; }
        setMouseRoute(r);
        props.post({
            command: 'widget_event',
            kind: 'onMouse',
            handler: {r},
        } as any)
    };
    return <WidgetErrorBoundary>
            <div onMouseMove={() => globalMouse([])}>
                <ViewHtml html={props.widget.html} post={props.post} globalMouse={globalMouse}/>
            </div>
    </WidgetErrorBoundary>
}

interface HtmlProps {
    html: WidgetComponent;
    post: (e: WidgetEventRequest) => void;
    globalMouse: (xs : number[]) => void;
    mouse?: () => void;
}

function isWidgetElement(w: WidgetHtml): w is WidgetElement {
    return (typeof w === 'object') && (w as any).t;
}

function ViewHtml(props: {html: WidgetHtml; post, globalMouse, mouse?}) {
    const {html, ...rest} = props;
    if (typeof html === 'string') {
        return html;
    } else if (!isWidgetElement(html)) {
        return ViewWidgetComponent({html, ...rest});
    } else {
        return ViewWidgetElement({ w:html, ...rest });
    }
}

function ViewWidgetElement(props: {w: WidgetElement; post; globalMouse; mouse?}) {
    const {w, post, mouse, ...rest} = props;
    const { t:tag, c:children, tt:tooltip } = w;
    let { a:attributes, e:events } = w;
    if (tag === 'hr') { return <hr />; }
    attributes = attributes || {};
    events = events || {};
    const new_attrs: any = {};
    for (const k of Object.getOwnPropertyNames(attributes)) {
        new_attrs[k] = attributes[k];
    }
    for (const k of Object.getOwnPropertyNames(events)) {
        if (['onClick', 'onMouseEnter', 'onMouseLeave'].includes(k)) {
            new_attrs[k] = (e) => post({
                command: 'widget_event',
                kind: k as any,
                handler: events[k],
                args: { type: 'unit' }
            });
        } else if (tag === 'input' && attributes.type === 'text' && k === 'onChange') {
            new_attrs.onChange = (e) => post({
                command: 'widget_event',
                kind: 'onChange',
                handler: events[k],
                args: { type: 'string', value: e.target.value }
            });
        } else {
            console.error(`unrecognised event kind ${k}`);
        }
    }
    if (mouse) {
        new_attrs["onMouseMove"] = (e: React.MouseEvent) => {
            e.stopPropagation();
            mouse();
        }
    }
    const vs = children.map(html => ViewHtml({html, post, ...rest}));
    if (tooltip) {
        return <Popper popperContent={ViewHtml({ html: tooltip, post, ...rest })} refEltTag={tag} refEltAttrs={new_attrs} key={new_attrs.key}>
            {vs}
        </Popper>
    } else if (children.length > 0) {
        return React.createElement(tag, new_attrs, vs);
    } else {
        return React.createElement(tag, new_attrs);
    }
}

function ViewWidgetComponent(props: HtmlProps) {
    const {c, mouse_capture, r} = props.html as any;
    let mouse = props.mouse;
    if (mouse_capture) {
        // I want mouse events.
        mouse = () => props.globalMouse(r);
    }
    return props.html.c.map(html => ViewHtml({...props, html, mouse}))
}

