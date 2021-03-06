'use strict';

var path = require('path');
var fs = require('fs');

function getFileNameNoExt(context) {
    let filename = path.basename(context.filename);
    let ext = path.extname(filename);

    if (ext === '.js') {
        return false;
    }

    if (ext) {
        filename = filename.slice(0, 0 - ext.length);
    }

    return filename;
}

const esprima = require('esprima');
const escodegen = require('escodegen');

function handleStyleElement(styleEl, transformHelper) {
    if (styleEl.bodyText) {
        return;
    }

    var attrs = styleEl.attributes;

    var styleCode;
    var lang = 'css';

    var hasStyleBlock = false;

    for (var i=attrs.length-1; i>=0; i--) {
        var attr = attrs[i];
        var name = attr.name;
        if (name.startsWith('{')) {
            hasStyleBlock = true;

            styleCode = name.slice(1, -1);
        } else if (name === 'class') {
            if (attr.value.type !== 'Literal' || typeof attr.value.value !== 'string') {
                return;
            }

            lang = attr.value.value;
        } else {
            if (hasStyleBlock) {
                transformHelper.context.addError(styleEl, 'Unsupported attribute on the component style tag: ' + attr.name);
                return;
            }
        }
    }

    if (styleCode == null) {
        return;
    }

    var context = transformHelper.context;
    context.addDependency({
        type: lang,
        code: styleCode.trim(),
        virtualPath: './'+path.basename(context.filename)+'.'+lang,
        path: './'+path.basename(context.filename)
    });

    styleEl.detach();
}

function methodToProperty(method) {
    return {
        type: 'Property',
        key: method.key,
        computed: false,
        value: method.value,
        kind: 'init',
        method: false,
        shorthand: false
    };
}

function classToObject(cls, transformHelper) {
    return {
        type: 'ObjectExpression',
        properties: cls.body.body.map((method) => {
            if(method.type != 'MethodDefinition') {
                throw Error('Only methods are allowed on single file component class definitions.');
            }

            if (method.kind === 'method') {
                return methodToProperty(method);
            } else if (method.kind === 'constructor') {
                let converted = methodToProperty(method);
                converted.key.name = 'onCreate';
                return converted;
            } else {
                return method;
            }
        })
    };
}

function handleClassDeclaration(classEl, transformHelper) {


    let tree;
    var wrappedSrc = '('+classEl.tagString+'\n)';

    try {
        tree = esprima.parse(wrappedSrc);
    } catch(err) {
        var message = 'Unable to parse JavaScript for componnet class. Error: ' + err;

        if (err.index != null) {
            var errorIndex = err.index;
            // message += '\n' + err.description;
            if (errorIndex != null && errorIndex >= 0) {
                transformHelper.context.addError({
                    pos: classEl.pos + errorIndex,
                    message: message
                });
                return;
            }
        }

        transformHelper.context.addError(classEl, message);
        return;
    }
    let expression = tree.body[0].expression;

    if (expression.superClass && expression.superClass.name) {
        transformHelper.context.addError(classEl, 'A component class is not allowed to use `extends`. See: https://github.com/marko-js/marko/wiki/Error:-Component-class-with-extends');
        return;
    }

    let object = classToObject(expression);
    let componentVar = transformHelper.context.addStaticVar('marko_component', escodegen.generate(object));

    if (transformHelper.getRendererModule() != null) {
        transformHelper.context.addError(classEl, 'The component has both an inline component `class` and a separate `component.js`. This is not allowed. See: https://github.com/marko-js/marko/wiki/Error:-Component-inline-and-external');
        return;
    }

    var moduleInfo = {
        inlineId: componentVar,
        filename: transformHelper.filename,
        requirePath: './' + path.basename(transformHelper.filename)
    };

    if (transformHelper.getComponentModule() == null) {
        transformHelper.setComponentModule(moduleInfo);
    }

    transformHelper.setRendererModule(moduleInfo);

    classEl.detach();
}

module.exports = function handleRootNodes() {
    var context = this.context;
    var builder = this.builder;
    var filename = getFileNameNoExt(context);
    var isEntry = 'index' === filename;

    if(!filename) {
        return; // inline component
    }

    var fileMatch = '('+filename.replace(/\./g, '\\.') + '\\.' + (isEntry ? '|' : '') + ')';
    var styleMatch = new RegExp('^'+fileMatch+'style\\.\\w+$');
    var componentMatch = new RegExp('^'+fileMatch+'component\\.\\w+$');
    var splitComponentMatch = new RegExp('^'+fileMatch+'component-browser\\.\\w+$');

    var templateRoot = this.el;

    var dirname = this.dirname;

    var dirFiles = fs.readdirSync(dirname);
    dirFiles.sort();

    for (let i=dirFiles.length - 1; i>=0; i--) {
        let file = dirFiles[i];
        if (styleMatch.test(file)) {
            context.addDependency('./' + file);
        } else if (splitComponentMatch.test(file)) {
            this.setComponentModule({
                filename: path.join(dirname, file),
                requirePath: './'+file.slice(0, file.lastIndexOf('.'))
            });
        } else if (componentMatch.test(file)) {
            var moduleInfo = {
                filename: path.join(dirname, file),
                requirePath: './'+file.slice(0, file.lastIndexOf('.'))
            };

            this.setComponentModule(moduleInfo);
            this.setRendererModule(moduleInfo);
        }
    }

    var rootNodes = [];
    var hasLegacyExplicitBind = false;
    var hasIdCount = 0;
    var nodeWithAssignedId;
    var assignedId;
    var transformHelper = this;

    let walker = context.createWalker({
        enter(node) {
            var tagName = node.tagName && node.tagName.toLowerCase();

            if (node.type === 'TemplateRoot' || !node.type) {
                // Don't worry about the TemplateRoot or an Container node
            } else if (node.type === 'HtmlElement') {
                if (node.hasAttribute('w-bind')) {
                    transformHelper.setHasBoundComponentForTemplate();
                    hasLegacyExplicitBind = true;
                } else {
                    if (node.hasAttribute('id')) {
                        hasIdCount++;
                        nodeWithAssignedId = node;
                        assignedId = node.getAttributeValue('id');
                    }

                    if (tagName === 'style') {
                        handleStyleElement(node, transformHelper);
                    } else {
                        rootNodes.push(node);
                    }
                }
                walker.skip();

                return;
            } else if (node.type === 'CustomTag') {
                rootNodes.push(node);

                walker.skip();
                return;
            } else {
                if (tagName === 'class') {
                    handleClassDeclaration(node, transformHelper);
                }

                walker.skip();
                return;
            }
        }
    });

    walker.walk(templateRoot);

    if (hasLegacyExplicitBind) {
        //There is an explicit bind so nothing to do
        return;
    }

    if (!this.hasBoundComponentForTemplate()) {
        return;
    }

    if (rootNodes.length === 0) {
        return;
    }

    if (rootNodes.length > 1 && hasIdCount > 0) {
        // We can only bind a component to multiple top-level elements if we can assign
        // all of the IDs
        return;
    }

    transformHelper.setHasBoundComponentForTemplate();

    var nextKey = 0;

    rootNodes.forEach((curNode, i) => {
        curNode.setAttributeValue('_componentbind');

        if (!curNode.hasAttribute('key') && !curNode.hasAttribute('ref')) {
            if (curNode.type === 'CustomTag' || rootNodes.length > 1) {
                curNode.setAttributeValue('key', builder.literal('_r' + (nextKey++)));
            }
        }
    });
};
