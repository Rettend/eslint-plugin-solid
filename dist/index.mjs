import { ASTUtils, ESLintUtils } from '@typescript-eslint/utils';
import isHtml from 'is-html';
import { traverse } from 'estraverse';
import kebabCase from 'kebab-case';
import { all } from 'known-css-properties';
import parse from 'style-to-object';

const { findVariable: findVariable$1 } = ASTUtils;
const domElementRegex = /^[a-z]/;
const isDOMElementName = (name) => domElementRegex.test(name);
const propsRegex = /[pP]rops/;
const isPropsByName = (name) => propsRegex.test(name);
const formatList = (strings) => {
  if (strings.length === 0) {
    return "";
  } else if (strings.length === 1) {
    return `'${strings[0]}'`;
  } else if (strings.length === 2) {
    return `'${strings[0]}' and '${strings[1]}'`;
  } else {
    const last = strings.length - 1;
    return `${strings.slice(0, last).map((s) => `'${s}'`).join(", ")}, and '${strings[last]}'`;
  }
};
const find = (node, predicate) => {
  let n = node;
  while (n) {
    const result = predicate(n);
    if (result) {
      return n;
    }
    n = n.parent;
  }
  return null;
};
function findParent(node, predicate) {
  return node.parent ? find(node.parent, predicate) : null;
}
function trace(node, initialScope) {
  if (node.type === "Identifier") {
    const variable = findVariable$1(initialScope, node);
    if (!variable)
      return node;
    const def = variable.defs[0];
    switch (def?.type) {
      case "FunctionName":
      case "ClassName":
      case "ImportBinding":
        return def.node;
      case "Variable":
        if ((def.node.parent.kind === "const" || variable.references.every((ref) => ref.init || ref.isReadOnly())) && def.node.id.type === "Identifier" && def.node.init) {
          return trace(def.node.init, initialScope);
        }
    }
  }
  return node;
}
function ignoreTransparentWrappers(node, up = false) {
  if (node.type === "TSAsExpression" || node.type === "TSNonNullExpression" || node.type === "TSSatisfiesExpression") {
    const next = up ? node.parent : node.expression;
    if (next) {
      return ignoreTransparentWrappers(next, up);
    }
  }
  return node;
}
const FUNCTION_TYPES = ["FunctionExpression", "ArrowFunctionExpression", "FunctionDeclaration"];
const isFunctionNode = (node) => !!node && FUNCTION_TYPES.includes(node.type);
const PROGRAM_OR_FUNCTION_TYPES = ["Program"].concat(FUNCTION_TYPES);
const isProgramOrFunctionNode = (node) => !!node && PROGRAM_OR_FUNCTION_TYPES.includes(node.type);
const isJSXElementOrFragment = (node) => node?.type === "JSXElement" || node?.type === "JSXFragment";
const getFunctionName = (node) => {
  if ((node.type === "FunctionDeclaration" || node.type === "FunctionExpression") && node.id != null) {
    return node.id.name;
  }
  if (node.parent?.type === "VariableDeclarator" && node.parent.id.type === "Identifier") {
    return node.parent.id.name;
  }
  return null;
};
function findInScope(node, scope, predicate) {
  const found = find(node, (node2) => node2 === scope || predicate(node2));
  return found === scope && !predicate(node) ? null : found;
}
const getCommentBefore = (node, sourceCode) => sourceCode.getCommentsBefore(node).find((comment) => comment.loc.end.line >= node.loc.start.line - 1);
const trackImports = (fromModule = /^solid-js(?:\/?|\b)/) => {
  const importMap = /* @__PURE__ */ new Map();
  const handleImportDeclaration = (node) => {
    if (fromModule.test(node.source.value)) {
      for (const specifier of node.specifiers) {
        if (specifier.type === "ImportSpecifier") {
          importMap.set(specifier.imported.name, specifier.local.name);
        }
      }
    }
  };
  const matchImport = (imports, str) => {
    const importArr = Array.isArray(imports) ? imports : [imports];
    return importArr.find((i) => importMap.get(i) === str);
  };
  return { matchImport, handleImportDeclaration };
};
function appendImports(fixer, sourceCode, importNode, identifiers) {
  const identifiersString = identifiers.join(", ");
  const reversedSpecifiers = importNode.specifiers.slice().reverse();
  const lastSpecifier = reversedSpecifiers.find((s) => s.type === "ImportSpecifier");
  if (lastSpecifier) {
    return fixer.insertTextAfter(lastSpecifier, `, ${identifiersString}`);
  }
  const otherSpecifier = importNode.specifiers.find(
    (s) => s.type === "ImportDefaultSpecifier" || s.type === "ImportNamespaceSpecifier"
  );
  if (otherSpecifier) {
    return fixer.insertTextAfter(otherSpecifier, `, { ${identifiersString} }`);
  }
  if (importNode.specifiers.length === 0) {
    const [importToken, maybeBrace] = sourceCode.getFirstTokens(importNode, { count: 2 });
    if (maybeBrace?.value === "{") {
      return fixer.insertTextAfter(maybeBrace, ` ${identifiersString} `);
    } else {
      return importToken ? fixer.insertTextAfter(importToken, ` { ${identifiersString} } from`) : null;
    }
  }
  return null;
}
function insertImports(fixer, sourceCode, source, identifiers, aboveImport, isType = false) {
  const identifiersString = identifiers.join(", ");
  const programNode = sourceCode.ast;
  const firstImport = aboveImport ?? programNode.body.find((n) => n.type === "ImportDeclaration");
  if (firstImport) {
    return fixer.insertTextBeforeRange(
      (getCommentBefore(firstImport, sourceCode) ?? firstImport).range,
      `import ${isType ? "type " : ""}{ ${identifiersString} } from "${source}";
`
    );
  }
  return fixer.insertTextBeforeRange(
    [0, 0],
    `import ${isType ? "type " : ""}{ ${identifiersString} } from "${source}";
`
  );
}
function removeSpecifier(fixer, sourceCode, specifier, pure = true) {
  const declaration = specifier.parent;
  if (declaration.specifiers.length === 1 && pure) {
    return fixer.remove(declaration);
  }
  const maybeComma = sourceCode.getTokenAfter(specifier);
  if (maybeComma?.value === ",") {
    return fixer.removeRange([specifier.range[0], maybeComma.range[1]]);
  }
  return fixer.remove(specifier);
}
function jsxPropName(prop) {
  if (prop.name.type === "JSXNamespacedName") {
    return `${prop.name.namespace.name}:${prop.name.name.name}`;
  }
  return prop.name.name;
}
function* jsxGetAllProps(props) {
  for (const attr of props) {
    if (attr.type === "JSXSpreadAttribute" && attr.argument.type === "ObjectExpression") {
      for (const property of attr.argument.properties) {
        if (property.type === "Property") {
          if (property.key.type === "Identifier") {
            yield [property.key.name, property.key];
          } else if (property.key.type === "Literal") {
            yield [String(property.key.value), property.key];
          }
        }
      }
    } else if (attr.type === "JSXAttribute") {
      yield [jsxPropName(attr), attr.name];
    }
  }
}
function jsxHasProp(props, prop) {
  for (const [p] of jsxGetAllProps(props)) {
    if (p === prop)
      return true;
  }
  return false;
}
function jsxGetProp(props, prop) {
  return props.find(
    (attribute) => attribute.type !== "JSXSpreadAttribute" && prop === jsxPropName(attribute)
  );
}

const createRule$j = ESLintUtils.RuleCreator.withoutDocs;
const isNothing = (node) => {
  if (!node) {
    return true;
  }
  switch (node.type) {
    case "Literal":
      return [null, void 0, false, ""].includes(node.value);
    case "JSXFragment":
      return !node.children || node.children.every(isNothing);
    default:
      return false;
  }
};
const getLineLength = (loc) => loc.end.line - loc.start.line + 1;
const rule$1 = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow early returns in components. Solid components only run once, and so conditionals should be inside JSX.",
      url: "https://github.com/solidjs-community/eslint-plugin-solid/blob/main/docs/components-return-once.md"
    },
    fixable: "code",
    schema: [],
    messages: {
      noEarlyReturn: "Solid components run once, so an early return breaks reactivity. Move the condition inside a JSX element, such as a fragment or <Show />.",
      noConditionalReturn: "Solid components run once, so a conditional return breaks reactivity. Move the condition inside a JSX element, such as a fragment or <Show />."
    }
  },
  defaultOptions: [],
  create(context) {
    const functionStack = [];
    const putIntoJSX = (node) => {
      const text = context.getSourceCode().getText(node);
      return node.type === "JSXElement" || node.type === "JSXFragment" ? text : `{${text}}`;
    };
    const currentFunction = () => functionStack[functionStack.length - 1];
    const onFunctionEnter = (node) => {
      let lastReturn;
      if (node.body.type === "BlockStatement") {
        const { length } = node.body.body;
        const last = length && node.body.body[length - 1];
        if (last && last.type === "ReturnStatement") {
          lastReturn = last;
        }
      }
      functionStack.push({ isComponent: false, lastReturn, earlyReturns: [] });
    };
    const onFunctionExit = (node) => {
      if (
        // "render props" aren't components
        getFunctionName(node)?.match(/^[a-z]/) || node.parent?.type === "JSXExpressionContainer" || // ignore createMemo(() => conditional JSX), report HOC(() => conditional JSX)
        node.parent?.type === "CallExpression" && node.parent.arguments.some((n) => n === node) && !node.parent.callee.name?.match(/^[A-Z]/)
      ) {
        currentFunction().isComponent = false;
      }
      if (currentFunction().isComponent) {
        currentFunction().earlyReturns.forEach((earlyReturn) => {
          context.report({
            node: earlyReturn,
            messageId: "noEarlyReturn"
          });
        });
        const argument = currentFunction().lastReturn?.argument;
        if (argument?.type === "ConditionalExpression") {
          const sourceCode = context.getSourceCode();
          context.report({
            node: argument.parent,
            messageId: "noConditionalReturn",
            fix: (fixer) => {
              const { test, consequent, alternate } = argument;
              const conditions = [{ test, consequent }];
              let fallback = alternate;
              while (fallback.type === "ConditionalExpression") {
                conditions.push({ test: fallback.test, consequent: fallback.consequent });
                fallback = fallback.alternate;
              }
              if (conditions.length >= 2) {
                const fallbackStr = !isNothing(fallback) ? ` fallback={${sourceCode.getText(fallback)}}` : "";
                return fixer.replaceText(
                  argument,
                  `<Switch${fallbackStr}>
${conditions.map(
                    ({ test: test2, consequent: consequent2 }) => `<Match when={${sourceCode.getText(test2)}}>${putIntoJSX(
                      consequent2
                    )}</Match>`
                  ).join("\n")}
</Switch>`
                );
              }
              if (isNothing(consequent)) {
                return fixer.replaceText(
                  argument,
                  `<Show when={!(${sourceCode.getText(test)})}>${putIntoJSX(alternate)}</Show>`
                );
              }
              if (isNothing(fallback) || getLineLength(consequent.loc) >= getLineLength(alternate.loc) * 1.5) {
                const fallbackStr = !isNothing(fallback) ? ` fallback={${sourceCode.getText(fallback)}}` : "";
                return fixer.replaceText(
                  argument,
                  `<Show when={${sourceCode.getText(test)}}${fallbackStr}>${putIntoJSX(
                    consequent
                  )}</Show>`
                );
              }
              return fixer.replaceText(argument, `<>${putIntoJSX(argument)}</>`);
            }
          });
        } else if (argument?.type === "LogicalExpression")
          if (argument.operator === "&&") {
            const sourceCode = context.getSourceCode();
            context.report({
              node: argument,
              messageId: "noConditionalReturn",
              fix: (fixer) => {
                const { left: test, right: consequent } = argument;
                return fixer.replaceText(
                  argument,
                  `<Show when={${sourceCode.getText(test)}}>${putIntoJSX(consequent)}</Show>`
                );
              }
            });
          } else {
            context.report({
              node: argument,
              messageId: "noConditionalReturn"
            });
          }
      }
      functionStack.pop();
    };
    return {
      FunctionDeclaration: onFunctionEnter,
      FunctionExpression: onFunctionEnter,
      ArrowFunctionExpression: onFunctionEnter,
      "FunctionDeclaration:exit": onFunctionExit,
      "FunctionExpression:exit": onFunctionExit,
      "ArrowFunctionExpression:exit": onFunctionExit,
      JSXElement() {
        if (functionStack.length) {
          currentFunction().isComponent = true;
        }
      },
      JSXFragment() {
        if (functionStack.length) {
          currentFunction().isComponent = true;
        }
      },
      ReturnStatement(node) {
        if (functionStack.length && node !== currentFunction().lastReturn) {
          currentFunction().earlyReturns.push(node);
        }
      }
    };
  }
};
const componentsReturnOnce = createRule$j(rule$1);

const createRule$i = ESLintUtils.RuleCreator.withoutDocs;
const { getStaticValue: getStaticValue$2 } = ASTUtils;
const COMMON_EVENTS = [
  "onAnimationEnd",
  "onAnimationIteration",
  "onAnimationStart",
  "onBeforeInput",
  "onBlur",
  "onChange",
  "onClick",
  "onContextMenu",
  "onCopy",
  "onCut",
  "onDblClick",
  "onDrag",
  "onDragEnd",
  "onDragEnter",
  "onDragExit",
  "onDragLeave",
  "onDragOver",
  "onDragStart",
  "onDrop",
  "onError",
  "onFocus",
  "onFocusIn",
  "onFocusOut",
  "onGotPointerCapture",
  "onInput",
  "onInvalid",
  "onKeyDown",
  "onKeyPress",
  "onKeyUp",
  "onLoad",
  "onLostPointerCapture",
  "onMouseDown",
  "onMouseEnter",
  "onMouseLeave",
  "onMouseMove",
  "onMouseOut",
  "onMouseOver",
  "onMouseUp",
  "onPaste",
  "onPointerCancel",
  "onPointerDown",
  "onPointerEnter",
  "onPointerLeave",
  "onPointerMove",
  "onPointerOut",
  "onPointerOver",
  "onPointerUp",
  "onReset",
  "onScroll",
  "onSelect",
  "onSubmit",
  "onToggle",
  "onTouchCancel",
  "onTouchEnd",
  "onTouchMove",
  "onTouchStart",
  "onTransitionEnd",
  "onWheel"
];
const COMMON_EVENTS_MAP = new Map(
  function* () {
    for (const event of COMMON_EVENTS) {
      yield [event.toLowerCase(), event];
    }
  }()
);
const NONSTANDARD_EVENTS_MAP = {
  ondoubleclick: "onDblClick"
};
const isCommonHandlerName = (lowercaseHandlerName) => COMMON_EVENTS_MAP.has(lowercaseHandlerName);
const getCommonEventHandlerName = (lowercaseHandlerName) => COMMON_EVENTS_MAP.get(lowercaseHandlerName);
const isNonstandardEventName = (lowercaseEventName) => Boolean(NONSTANDARD_EVENTS_MAP[lowercaseEventName]);
const getStandardEventHandlerName = (lowercaseEventName) => NONSTANDARD_EVENTS_MAP[lowercaseEventName];
const rule = {
  meta: {
    type: "problem",
    docs: {
      description: "Enforce naming DOM element event handlers consistently and prevent Solid's analysis from misunderstanding whether a prop should be an event handler.",
      url: "https://github.com/solidjs-community/eslint-plugin-solid/blob/main/docs/event-handlers.md"
    },
    fixable: "code",
    hasSuggestions: true,
    schema: [
      {
        type: "object",
        properties: {
          ignoreCase: {
            type: "boolean",
            description: "if true, don't warn on ambiguously named event handlers like `onclick` or `onchange`",
            default: false
          },
          warnOnSpread: {
            type: "boolean",
            description: "if true, warn when spreading event handlers onto JSX. Enable for Solid < v1.6.",
            default: false
          }
        },
        additionalProperties: false
      }
    ],
    messages: {
      "detected-attr": 'The {{name}} prop is named as an event handler (starts with "on"), but Solid knows its value ({{staticValue}}) is a string or number, so it will be treated as an attribute. If this is intentional, name this prop attr:{{name}}.',
      naming: "The {{name}} prop is ambiguous. If it is an event handler, change it to {{handlerName}}. If it is an attribute, change it to {{attrName}}.",
      capitalization: "The {{name}} prop should be renamed to {{fixedName}} for readability.",
      nonstandard: "The {{name}} prop should be renamed to {{fixedName}}, because it's not a standard event handler.",
      "make-handler": "Change the {{name}} prop to {{handlerName}}.",
      "make-attr": "Change the {{name}} prop to {{attrName}}.",
      "spread-handler": "The {{name}} prop should be added as a JSX attribute, not spread in. Solid doesn't add listeners when spreading into JSX."
    }
  },
  defaultOptions: [],
  create(context) {
    const sourceCode = context.getSourceCode();
    return {
      JSXAttribute(node) {
        const openingElement = node.parent;
        if (openingElement.name.type !== "JSXIdentifier" || !isDOMElementName(openingElement.name.name)) {
          return;
        }
        if (node.name.type === "JSXNamespacedName") {
          return;
        }
        const { name } = node.name;
        if (!/^on[a-zA-Z]/.test(name)) {
          return;
        }
        let staticValue = null;
        if (node.value?.type === "JSXExpressionContainer" && node.value.expression.type !== "JSXEmptyExpression" && node.value.expression.type !== "ArrayExpression" && // array syntax prevents inlining
        (staticValue = getStaticValue$2(node.value.expression, context.getScope())) !== null && (typeof staticValue.value === "string" || typeof staticValue.value === "number")) {
          context.report({
            node,
            messageId: "detected-attr",
            data: {
              name,
              staticValue: staticValue.value
            }
          });
        } else if (node.value === null || node.value?.type === "Literal") {
          context.report({
            node,
            messageId: "detected-attr",
            data: {
              name,
              staticValue: node.value !== null ? node.value.value : true
            }
          });
        } else if (!context.options[0]?.ignoreCase) {
          const lowercaseHandlerName = name.toLowerCase();
          if (isNonstandardEventName(lowercaseHandlerName)) {
            const fixedName = getStandardEventHandlerName(lowercaseHandlerName);
            context.report({
              node: node.name,
              messageId: "nonstandard",
              data: { name, fixedName },
              fix: (fixer) => fixer.replaceText(node.name, fixedName)
            });
          } else if (isCommonHandlerName(lowercaseHandlerName)) {
            const fixedName = getCommonEventHandlerName(lowercaseHandlerName);
            if (fixedName !== name) {
              context.report({
                node: node.name,
                messageId: "capitalization",
                data: { name, fixedName },
                fix: (fixer) => fixer.replaceText(node.name, fixedName)
              });
            }
          } else if (name[2] === name[2].toLowerCase()) {
            const handlerName = `on${name[2].toUpperCase()}${name.slice(3)}`;
            const attrName = `attr:${name}`;
            context.report({
              node: node.name,
              messageId: "naming",
              data: { name, attrName, handlerName },
              suggest: [
                {
                  messageId: "make-handler",
                  data: { name, handlerName },
                  fix: (fixer) => fixer.replaceText(node.name, handlerName)
                },
                {
                  messageId: "make-attr",
                  data: { name, attrName },
                  fix: (fixer) => fixer.replaceText(node.name, attrName)
                }
              ]
            });
          }
        }
      },
      Property(node) {
        if (context.options[0]?.warnOnSpread && node.parent?.type === "ObjectExpression" && node.parent.parent?.type === "JSXSpreadAttribute" && node.parent.parent.parent?.type === "JSXOpeningElement") {
          const openingElement = node.parent.parent.parent;
          if (openingElement.name.type === "JSXIdentifier" && isDOMElementName(openingElement.name.name)) {
            if (node.key.type === "Identifier" && /^on/.test(node.key.name)) {
              const handlerName = node.key.name;
              context.report({
                node,
                messageId: "spread-handler",
                data: {
                  name: node.key.name
                },
                *fix(fixer) {
                  const commaAfter = sourceCode.getTokenAfter(node);
                  yield fixer.remove(
                    node.parent.properties.length === 1 ? node.parent.parent : node
                  );
                  if (commaAfter?.value === ",") {
                    yield fixer.remove(commaAfter);
                  }
                  yield fixer.insertTextAfter(
                    node.parent.parent,
                    ` ${handlerName}={${sourceCode.getText(node.value)}}`
                  );
                }
              });
            }
          }
        }
      }
    };
  }
};
const eventHandlers = createRule$i(rule);

const createRule$h = ESLintUtils.RuleCreator.withoutDocs;
const primitiveMap = /* @__PURE__ */ new Map();
for (const primitive of [
  "createSignal",
  "createEffect",
  "createMemo",
  "createResource",
  "onMount",
  "onCleanup",
  "onError",
  "untrack",
  "batch",
  "on",
  "createRoot",
  "getOwner",
  "runWithOwner",
  "mergeProps",
  "splitProps",
  "useTransition",
  "observable",
  "from",
  "mapArray",
  "indexArray",
  "createContext",
  "useContext",
  "children",
  "lazy",
  "createUniqueId",
  "createDeferred",
  "createRenderEffect",
  "createComputed",
  "createReaction",
  "createSelector",
  "DEV",
  "For",
  "Show",
  "Switch",
  "Match",
  "Index",
  "ErrorBoundary",
  "Suspense",
  "SuspenseList"
]) {
  primitiveMap.set(primitive, "solid-js");
}
for (const primitive of [
  "Portal",
  "render",
  "hydrate",
  "renderToString",
  "renderToStream",
  "isServer",
  "renderToStringAsync",
  "generateHydrationScript",
  "HydrationScript",
  "Dynamic"
]) {
  primitiveMap.set(primitive, "solid-js/web");
}
for (const primitive of [
  "createStore",
  "produce",
  "reconcile",
  "unwrap",
  "createMutable",
  "modifyMutable"
]) {
  primitiveMap.set(primitive, "solid-js/store");
}
const typeMap = /* @__PURE__ */ new Map();
for (const type of [
  "Signal",
  "Accessor",
  "Setter",
  "Resource",
  "ResourceActions",
  "ResourceOptions",
  "ResourceReturn",
  "ResourceFetcher",
  "InitializedResourceReturn",
  "Component",
  "VoidProps",
  "VoidComponent",
  "ParentProps",
  "ParentComponent",
  "FlowProps",
  "FlowComponent",
  "ValidComponent",
  "ComponentProps",
  "Ref",
  "MergeProps",
  "SplitPrips",
  "Context",
  "JSX",
  "ResolvedChildren",
  "MatchProps"
]) {
  typeMap.set(type, "solid-js");
}
for (const type of [
  /* "JSX", */
  "MountableElement"
]) {
  typeMap.set(type, "solid-js/web");
}
for (const type of ["StoreNode", "Store", "SetStoreFunction"]) {
  typeMap.set(type, "solid-js/store");
}
const sourceRegex = /^solid-js(?:\/web|\/store)?$/;
const isSource = (source) => sourceRegex.test(source);
const imports = createRule$h({
  meta: {
    type: "suggestion",
    docs: {
      description: 'Enforce consistent imports from "solid-js", "solid-js/web", and "solid-js/store".',
      url: "https://github.com/solidjs-community/eslint-plugin-solid/blob/main/docs/imports.md"
    },
    fixable: "code",
    schema: [],
    messages: {
      "prefer-source": 'Prefer importing {{name}} from "{{source}}".'
    }
  },
  defaultOptions: [],
  create(context) {
    return {
      ImportDeclaration(node) {
        const source = node.source.value;
        if (!isSource(source))
          return;
        for (const specifier of node.specifiers) {
          if (specifier.type === "ImportSpecifier") {
            const isType = specifier.importKind === "type" || node.importKind === "type";
            const map = isType ? typeMap : primitiveMap;
            const correctSource = map.get(specifier.imported.name);
            if (correctSource != null && correctSource !== source) {
              context.report({
                node: specifier,
                messageId: "prefer-source",
                data: {
                  name: specifier.imported.name,
                  source: correctSource
                },
                fix(fixer) {
                  const sourceCode = context.getSourceCode();
                  const program = sourceCode.ast;
                  const correctDeclaration = program.body.find(
                    (node2) => node2.type === "ImportDeclaration" && node2.source.value === correctSource
                  );
                  if (correctDeclaration) {
                    return [
                      removeSpecifier(fixer, sourceCode, specifier),
                      appendImports(fixer, sourceCode, correctDeclaration, [
                        sourceCode.getText(specifier)
                      ])
                    ].filter(Boolean);
                  }
                  const firstSolidDeclaration = program.body.find(
                    (node2) => node2.type === "ImportDeclaration" && isSource(node2.source.value)
                  );
                  return [
                    removeSpecifier(fixer, sourceCode, specifier),
                    insertImports(
                      fixer,
                      sourceCode,
                      correctSource,
                      [sourceCode.getText(specifier)],
                      firstSolidDeclaration,
                      isType
                    )
                  ];
                }
              });
            }
          }
        }
      }
    };
  }
});

const createRule$g = ESLintUtils.RuleCreator.withoutDocs;
const jsxNoDuplicateProps = createRule$g({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow passing the same prop twice in JSX.",
      url: "https://github.com/solidjs-community/eslint-plugin-solid/blob/main/docs/jsx-no-duplicate-props.md"
    },
    schema: [
      {
        type: "object",
        properties: {
          ignoreCase: {
            type: "boolean",
            description: "Consider two prop names differing only by case to be the same.",
            default: false
          }
        }
      }
    ],
    messages: {
      noDuplicateProps: "Duplicate props are not allowed.",
      noDuplicateClass: "Duplicate `class` props are not allowed; while it might seem to work, it can break unexpectedly. Use `classList` instead.",
      noDuplicateChildren: "Using {{used}} at the same time is not allowed."
    }
  },
  defaultOptions: [],
  create(context) {
    return {
      JSXOpeningElement(node) {
        const ignoreCase = context.options[0]?.ignoreCase ?? false;
        const props = /* @__PURE__ */ new Set();
        const checkPropName = (name, node2) => {
          if (ignoreCase || name.startsWith("on")) {
            name = name.toLowerCase().replace(/^on(?:capture)?:/, "on").replace(/^(?:attr|prop):/, "");
          }
          if (props.has(name)) {
            context.report({
              node: node2,
              messageId: name === "class" ? "noDuplicateClass" : "noDuplicateProps"
            });
          }
          props.add(name);
        };
        for (const [name, propNode] of jsxGetAllProps(node.attributes)) {
          checkPropName(name, propNode);
        }
        const hasChildrenProp = props.has("children");
        const hasChildren = node.parent.children.length > 0;
        const hasInnerHTML = props.has("innerHTML") || props.has("innerhtml");
        const hasTextContent = props.has("textContent") || props.has("textContent");
        const used = [
          hasChildrenProp && "`props.children`",
          hasChildren && "JSX children",
          hasInnerHTML && "`props.innerHTML`",
          hasTextContent && "`props.textContent`"
        ].filter(Boolean);
        if (used.length > 1) {
          context.report({
            node,
            messageId: "noDuplicateChildren",
            data: {
              used: used.join(", ")
            }
          });
        }
      }
    };
  }
});

const createRule$f = ESLintUtils.RuleCreator.withoutDocs;
const { getStaticValue: getStaticValue$1 } = ASTUtils;
const isJavaScriptProtocol = /^[\u0000-\u001F ]*j[\r\n\t]*a[\r\n\t]*v[\r\n\t]*a[\r\n\t]*s[\r\n\t]*c[\r\n\t]*r[\r\n\t]*i[\r\n\t]*p[\r\n\t]*t[\r\n\t]*:/i;
const jsxNoScriptUrl = createRule$f({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow javascript: URLs.",
      url: "https://github.com/solidjs-community/eslint-plugin-solid/blob/main/docs/jsx-no-script-url.md"
    },
    schema: [],
    messages: {
      noJSURL: "For security, don't use javascript: URLs. Use event handlers instead if you can."
    }
  },
  defaultOptions: [],
  create(context) {
    return {
      JSXAttribute(node) {
        if (node.name.type === "JSXIdentifier" && node.value) {
          const link = getStaticValue$1(
            node.value.type === "JSXExpressionContainer" ? node.value.expression : node.value,
            context.getScope()
          );
          if (link && typeof link.value === "string" && isJavaScriptProtocol.test(link.value)) {
            context.report({
              node: node.value,
              messageId: "noJSURL"
            });
          }
        }
      }
    };
  }
});

const createRule$e = ESLintUtils.RuleCreator.withoutDocs;
const AUTO_COMPONENTS = ["Show", "For", "Index", "Switch", "Match"];
const SOURCE_MODULE = "solid-js";
const jsxNoUndef = createRule$e({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow references to undefined variables in JSX. Handles custom directives.",
      url: "https://github.com/solidjs-community/eslint-plugin-solid/blob/main/docs/jsx-no-undef.md"
    },
    fixable: "code",
    schema: [
      {
        type: "object",
        properties: {
          allowGlobals: {
            type: "boolean",
            description: "When true, the rule will consider the global scope when checking for defined components.",
            default: false
          },
          autoImport: {
            type: "boolean",
            description: 'Automatically import certain components from `"solid-js"` if they are undefined.',
            default: true
          },
          typescriptEnabled: {
            type: "boolean",
            description: "Adjusts behavior not to conflict with TypeScript's type checking.",
            default: false
          }
        },
        additionalProperties: false
      }
    ],
    messages: {
      undefined: "'{{identifier}}' is not defined.",
      customDirectiveUndefined: "Custom directive '{{identifier}}' is not defined.",
      autoImport: "{{imports}} should be imported from '{{source}}'."
    }
  },
  defaultOptions: [],
  create(context) {
    const allowGlobals = context.options[0]?.allowGlobals ?? false;
    const autoImport = context.options[0]?.autoImport !== false;
    const isTypeScriptEnabled = context.options[0]?.typescriptEnabled ?? false;
    const missingComponentsSet = /* @__PURE__ */ new Set();
    function checkIdentifierInJSX(node, {
      isComponent,
      isCustomDirective
    } = {}) {
      let scope = context.getScope();
      const sourceCode = context.getSourceCode();
      const sourceType = sourceCode.ast.sourceType;
      const scopeUpperBound = !allowGlobals && sourceType === "module" ? "module" : "global";
      const variables = [...scope.variables];
      if (node.name === "this") {
        return;
      }
      while (scope.type !== scopeUpperBound && scope.type !== "global" && scope.upper) {
        scope = scope.upper;
        variables.push(...scope.variables);
      }
      if (scope.childScopes.length) {
        variables.push(...scope.childScopes[0].variables);
        if (scope.childScopes[0].childScopes.length) {
          variables.push(...scope.childScopes[0].childScopes[0].variables);
        }
      }
      if (variables.find((variable) => variable.name === node.name)) {
        return;
      }
      if (isComponent && autoImport && AUTO_COMPONENTS.includes(node.name) && !missingComponentsSet.has(node.name)) {
        missingComponentsSet.add(node.name);
      } else if (isCustomDirective) {
        context.report({
          node,
          messageId: "customDirectiveUndefined",
          data: {
            identifier: node.name
          }
        });
      } else if (!isTypeScriptEnabled) {
        context.report({
          node,
          messageId: "undefined",
          data: {
            identifier: node.name
          }
        });
      }
    }
    return {
      JSXOpeningElement(node) {
        let n;
        switch (node.name.type) {
          case "JSXIdentifier":
            if (!isDOMElementName(node.name.name)) {
              checkIdentifierInJSX(node.name, { isComponent: true });
            }
            break;
          case "JSXMemberExpression":
            n = node.name;
            do {
              n = n.object;
            } while (n && n.type !== "JSXIdentifier");
            if (n) {
              checkIdentifierInJSX(n);
            }
            break;
        }
      },
      "JSXAttribute > JSXNamespacedName": (node) => {
        if (node.namespace?.type === "JSXIdentifier" && node.namespace.name === "use" && node.name?.type === "JSXIdentifier") {
          checkIdentifierInJSX(node.name, { isCustomDirective: true });
        }
      },
      "Program:exit": (programNode) => {
        const missingComponents = Array.from(missingComponentsSet.values());
        if (autoImport && missingComponents.length) {
          const importNode = programNode.body.find(
            (n) => n.type === "ImportDeclaration" && n.importKind !== "type" && n.source.type === "Literal" && n.source.value === SOURCE_MODULE
          );
          if (importNode) {
            context.report({
              node: importNode,
              messageId: "autoImport",
              data: {
                imports: formatList(missingComponents),
                // "Show, For, and Switch"
                source: SOURCE_MODULE
              },
              fix: (fixer) => {
                return appendImports(fixer, context.getSourceCode(), importNode, missingComponents);
              }
            });
          } else {
            context.report({
              node: programNode,
              messageId: "autoImport",
              data: {
                imports: formatList(missingComponents),
                source: SOURCE_MODULE
              },
              fix: (fixer) => {
                return insertImports(fixer, context.getSourceCode(), "solid-js", missingComponents);
              }
            });
          }
        }
      }
    };
  }
});

const createRule$d = ESLintUtils.RuleCreator.withoutDocs;
const jsxUsesVars = createRule$d({
  meta: {
    type: "problem",
    docs: {
      // eslint-disable-next-line eslint-plugin/require-meta-docs-description
      description: "Prevent variables used in JSX from being marked as unused.",
      url: "https://github.com/solidjs-community/eslint-plugin-solid/blob/main/docs/jsx-uses-vars.md"
    },
    schema: [],
    // eslint-disable-next-line eslint-plugin/prefer-message-ids
    messages: {}
  },
  defaultOptions: [],
  create(context) {
    return {
      JSXOpeningElement(node) {
        let parent;
        switch (node.name.type) {
          case "JSXNamespacedName":
            return;
          case "JSXIdentifier":
            context.markVariableAsUsed(node.name.name);
            break;
          case "JSXMemberExpression":
            parent = node.name.object;
            while (parent?.type === "JSXMemberExpression") {
              parent = parent.object;
            }
            if (parent.type === "JSXIdentifier") {
              context.markVariableAsUsed(parent.name);
            }
            break;
        }
      },
      "JSXAttribute > JSXNamespacedName": (node) => {
        if (node.namespace?.type === "JSXIdentifier" && node.namespace.name === "use" && node.name?.type === "JSXIdentifier") {
          context.markVariableAsUsed(node.name.name);
        }
      }
    };
  }
});

const createRule$c = ESLintUtils.RuleCreator.withoutDocs;
const { getStringIfConstant: getStringIfConstant$1 } = ASTUtils;
const getName = (node) => {
  switch (node.type) {
    case "Literal":
      return typeof node.value === "string" ? node.value : null;
    case "Identifier":
      return node.name;
    case "AssignmentPattern":
      return getName(node.left);
    default:
      return getStringIfConstant$1(node);
  }
};
const getPropertyInfo = (prop) => {
  const valueName = getName(prop.value);
  if (valueName !== null) {
    return {
      real: prop.key,
      var: valueName,
      computed: prop.computed,
      init: prop.value.type === "AssignmentPattern" ? prop.value.right : void 0
    };
  } else {
    return null;
  }
};
const noDestructure = createRule$c({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow destructuring props. In Solid, props must be used with property accesses (`props.foo`) to preserve reactivity. This rule only tracks destructuring in the parameter list.",
      url: "https://github.com/solidjs-community/eslint-plugin-solid/blob/main/docs/no-destructure.md"
    },
    fixable: "code",
    schema: [],
    messages: {
      noDestructure: "Destructuring component props breaks Solid's reactivity; use property access instead."
      // noWriteToProps: "Component props are readonly, writing to props is not supported.",
    }
  },
  defaultOptions: [],
  create(context) {
    const functionStack = [];
    const currentFunction = () => functionStack[functionStack.length - 1];
    const onFunctionEnter = () => {
      functionStack.push({ hasJSX: false });
    };
    const onFunctionExit = (node) => {
      if (node.params.length === 1) {
        const props = node.params[0];
        if (props.type === "ObjectPattern" && currentFunction().hasJSX && node.parent?.type !== "JSXExpressionContainer") {
          context.report({
            node: props,
            messageId: "noDestructure",
            fix: (fixer) => fixDestructure(node, props, fixer)
          });
        }
      }
      functionStack.pop();
    };
    function* fixDestructure(func, props, fixer) {
      const propsName = "props";
      const properties = props.properties;
      const propertyInfo = [];
      let rest = null;
      for (const property of properties) {
        if (property.type === "RestElement") {
          rest = property;
        } else {
          const info = getPropertyInfo(property);
          if (info === null) {
            continue;
          }
          propertyInfo.push(info);
        }
      }
      const hasDefaults = propertyInfo.some((info) => info.init);
      const origProps = !(hasDefaults || rest) ? propsName : "_" + propsName;
      if (props.typeAnnotation) {
        const range = [props.range[0], props.typeAnnotation.range[0]];
        yield fixer.replaceTextRange(range, origProps);
      } else {
        yield fixer.replaceText(props, origProps);
      }
      const sourceCode = context.getSourceCode();
      const defaultsObjectString = () => propertyInfo.filter((info) => info.init).map(
        (info) => `${info.computed ? "[" : ""}${sourceCode.getText(info.real)}${info.computed ? "]" : ""}: ${sourceCode.getText(info.init)}`
      ).join(", ");
      const splitPropsArray = () => `[${propertyInfo.map(
        (info) => info.real.type === "Identifier" ? JSON.stringify(info.real.name) : sourceCode.getText(info.real)
      ).join(", ")}]`;
      let lineToInsert = "";
      if (hasDefaults && rest) {
        lineToInsert = `  const [${propsName}, ${rest.argument.type === "Identifier" && rest.argument.name || "rest"}] = splitProps(mergeProps({ ${defaultsObjectString()} }, ${origProps}), ${splitPropsArray()});`;
      } else if (hasDefaults) {
        lineToInsert = `  const ${propsName} = mergeProps({ ${defaultsObjectString()} }, ${origProps});
`;
      } else if (rest) {
        lineToInsert = `  const [${propsName}, ${rest.argument.type === "Identifier" && rest.argument.name || "rest"}] = splitProps(${origProps}, ${splitPropsArray()});
`;
      }
      if (lineToInsert) {
        const body = func.body;
        if (body.type === "BlockStatement") {
          if (body.body.length > 0) {
            yield fixer.insertTextBefore(body.body[0], lineToInsert);
          }
        } else {
          const maybeOpenParen = sourceCode.getTokenBefore(body);
          if (maybeOpenParen?.value === "(") {
            yield fixer.remove(maybeOpenParen);
          }
          const maybeCloseParen = sourceCode.getTokenAfter(body);
          if (maybeCloseParen?.value === ")") {
            yield fixer.remove(maybeCloseParen);
          }
          yield fixer.insertTextBefore(body, `{
${lineToInsert}  return (`);
          yield fixer.insertTextAfter(body, `);
}`);
        }
      }
      const scope = sourceCode.scopeManager?.acquire(func);
      if (scope) {
        for (const [info, variable] of propertyInfo.map(
          (info2) => [info2, scope.set.get(info2.var)]
        )) {
          if (variable) {
            for (const reference of variable.references) {
              if (reference.isReadOnly()) {
                const access = info.real.type === "Identifier" && !info.computed ? `.${info.real.name}` : `[${sourceCode.getText(info.real)}]`;
                yield fixer.replaceText(reference.identifier, `${propsName}${access}`);
              }
            }
          }
        }
      }
    }
    return {
      FunctionDeclaration: onFunctionEnter,
      FunctionExpression: onFunctionEnter,
      ArrowFunctionExpression: onFunctionEnter,
      "FunctionDeclaration:exit": onFunctionExit,
      "FunctionExpression:exit": onFunctionExit,
      "ArrowFunctionExpression:exit": onFunctionExit,
      JSXElement() {
        if (functionStack.length) {
          currentFunction().hasJSX = true;
        }
      },
      JSXFragment() {
        if (functionStack.length) {
          currentFunction().hasJSX = true;
        }
      }
    };
  }
});

const createRule$b = ESLintUtils.RuleCreator.withoutDocs;
const { getStringIfConstant } = ASTUtils;
const noInnerHTML = createRule$b({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow usage of the innerHTML attribute, which can often lead to security vulnerabilities.",
      url: "https://github.com/solidjs-community/eslint-plugin-solid/blob/main/docs/no-innerhtml.md"
    },
    fixable: "code",
    hasSuggestions: true,
    schema: [
      {
        type: "object",
        properties: {
          allowStatic: {
            description: "if the innerHTML value is guaranteed to be a static HTML string (i.e. no user input), allow it",
            type: "boolean",
            default: true
          }
        },
        additionalProperties: false
      }
    ],
    messages: {
      dangerous: "The innerHTML attribute is dangerous; passing unsanitized input can lead to security vulnerabilities.",
      conflict: "The innerHTML attribute should not be used on an element with child elements; they will be overwritten.",
      notHtml: "The string passed to innerHTML does not appear to be valid HTML.",
      useInnerText: "For text content, using innerText is clearer and safer.",
      dangerouslySetInnerHTML: "The dangerouslySetInnerHTML prop is not supported; use innerHTML instead."
    }
  },
  defaultOptions: [{ allowStatic: true }],
  create(context) {
    const allowStatic = Boolean(context.options[0]?.allowStatic ?? true);
    return {
      JSXAttribute(node) {
        if (jsxPropName(node) === "dangerouslySetInnerHTML") {
          if (node.value?.type === "JSXExpressionContainer" && node.value.expression.type === "ObjectExpression" && node.value.expression.properties.length === 1) {
            const htmlProp = node.value.expression.properties[0];
            if (htmlProp.type === "Property" && htmlProp.key.type === "Identifier" && htmlProp.key.name === "__html") {
              context.report({
                node,
                messageId: "dangerouslySetInnerHTML",
                fix: (fixer) => {
                  const propRange = node.range;
                  const valueRange = htmlProp.value.range;
                  return [
                    fixer.replaceTextRange([propRange[0], valueRange[0]], "innerHTML={"),
                    fixer.replaceTextRange([valueRange[1], propRange[1]], "}")
                  ];
                }
              });
            } else {
              context.report({
                node,
                messageId: "dangerouslySetInnerHTML"
              });
            }
          } else {
            context.report({
              node,
              messageId: "dangerouslySetInnerHTML"
            });
          }
          return;
        } else if (jsxPropName(node) !== "innerHTML") {
          return;
        }
        if (allowStatic) {
          const innerHtmlNode = node.value?.type === "JSXExpressionContainer" ? node.value.expression : node.value;
          const innerHtml = innerHtmlNode && getStringIfConstant(innerHtmlNode);
          if (typeof innerHtml === "string") {
            if (isHtml(innerHtml)) {
              if (node.parent?.parent?.type === "JSXElement" && node.parent.parent.children?.length) {
                context.report({
                  node: node.parent.parent,
                  // report error on JSXElement instead of JSXAttribute
                  messageId: "conflict"
                });
              }
            } else {
              context.report({
                node,
                messageId: "notHtml",
                suggest: [
                  {
                    fix: (fixer) => fixer.replaceText(node.name, "innerText"),
                    messageId: "useInnerText"
                  }
                ]
              });
            }
          } else {
            context.report({
              node,
              messageId: "dangerous"
            });
          }
        } else {
          context.report({
            node,
            messageId: "dangerous"
          });
        }
      }
    };
  }
});

const createRule$a = ESLintUtils.RuleCreator.withoutDocs;
const noProxyApis = createRule$a({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow usage of APIs that use ES6 Proxies, only to target environments that don't support them.",
      url: "https://github.com/solidjs-community/eslint-plugin-solid/blob/main/docs/no-proxy-apis.md"
    },
    schema: [],
    messages: {
      noStore: "Solid Store APIs use Proxies, which are incompatible with your target environment.",
      spreadCall: "Using a function call in JSX spread makes Solid use Proxies, which are incompatible with your target environment.",
      spreadMember: "Using a property access in JSX spread makes Solid use Proxies, which are incompatible with your target environment.",
      proxyLiteral: "Proxies are incompatible with your target environment.",
      mergeProps: "If you pass a function to `mergeProps`, it will create a Proxy, which are incompatible with your target environment."
    }
  },
  defaultOptions: [],
  create(context) {
    const { matchImport, handleImportDeclaration } = trackImports();
    return {
      ImportDeclaration(node) {
        handleImportDeclaration(node);
        const source = node.source.value;
        if (source === "solid-js/store") {
          context.report({
            node,
            messageId: "noStore"
          });
        }
      },
      "JSXSpreadAttribute MemberExpression"(node) {
        context.report({ node, messageId: "spreadMember" });
      },
      "JSXSpreadAttribute CallExpression"(node) {
        context.report({ node, messageId: "spreadCall" });
      },
      CallExpression(node) {
        if (node.callee.type === "Identifier") {
          if (matchImport("mergeProps", node.callee.name)) {
            node.arguments.filter((arg) => {
              if (arg.type === "SpreadElement")
                return true;
              const traced = trace(arg, context.getScope());
              return traced.type === "Identifier" && !isPropsByName(traced.name) || isFunctionNode(traced);
            }).forEach((badArg) => {
              context.report({
                node: badArg,
                messageId: "mergeProps"
              });
            });
          }
        } else if (node.callee.type === "MemberExpression") {
          if (node.callee.object.type === "Identifier" && node.callee.object.name === "Proxy" && node.callee.property.type === "Identifier" && node.callee.property.name === "revocable") {
            context.report({
              node,
              messageId: "proxyLiteral"
            });
          }
        }
      },
      NewExpression(node) {
        if (node.callee.type === "Identifier" && node.callee.name === "Proxy") {
          context.report({ node, messageId: "proxyLiteral" });
        }
      }
    };
  }
});

const createRule$9 = ESLintUtils.RuleCreator.withoutDocs;
const noReactDeps = createRule$9({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow usage of dependency arrays in `createEffect` and `createMemo`.",
      url: "https://github.com/solidjs-community/eslint-plugin-solid/blob/main/docs/no-react-deps.md"
    },
    fixable: "code",
    schema: [],
    messages: {
      noUselessDep: "In Solid, `{{name}}` doesn't accept a dependency array because it automatically tracks its dependencies. If you really need to override the list of dependencies, use `on`."
    }
  },
  defaultOptions: [],
  create(context) {
    const { matchImport, handleImportDeclaration } = trackImports();
    return {
      ImportDeclaration: handleImportDeclaration,
      CallExpression(node) {
        if (node.callee.type === "Identifier" && matchImport(["createEffect", "createMemo"], node.callee.name) && node.arguments.length === 2 && node.arguments.every((arg) => arg.type !== "SpreadElement")) {
          const [arg0, arg1] = node.arguments.map((arg) => trace(arg, context.getScope()));
          if (isFunctionNode(arg0) && arg0.params.length === 0 && arg1.type === "ArrayExpression") {
            context.report({
              node: node.arguments[1],
              // if this is a variable, highlight the usage, not the initialization
              messageId: "noUselessDep",
              data: {
                name: node.callee.name
              },
              // remove dep array if it's given inline, otherwise don't fix
              fix: arg1 === node.arguments[1] ? (fixer) => fixer.remove(arg1) : void 0
            });
          }
        }
      }
    };
  }
});

const createRule$8 = ESLintUtils.RuleCreator.withoutDocs;
const reactSpecificProps = [
  { from: "className", to: "class" },
  { from: "htmlFor", to: "for" }
];
const noReactSpecificProps = createRule$8({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow usage of React-specific `className`/`htmlFor` props, which were deprecated in v1.4.0.",
      url: "https://github.com/solidjs-community/eslint-plugin-solid/blob/main/docs/no-react-specific-props.md"
    },
    fixable: "code",
    schema: [],
    messages: {
      prefer: "Prefer the `{{ to }}` prop over the deprecated `{{ from }}` prop.",
      noUselessKey: "Elements in a <For> or <Index> list do not need a key prop."
    }
  },
  defaultOptions: [],
  create(context) {
    return {
      JSXOpeningElement(node) {
        for (const { from, to } of reactSpecificProps) {
          const classNameAttribute = jsxGetProp(node.attributes, from);
          if (classNameAttribute) {
            const fix = !jsxHasProp(node.attributes, to) ? (fixer) => fixer.replaceText(classNameAttribute.name, to) : void 0;
            context.report({
              node: classNameAttribute,
              messageId: "prefer",
              data: { from, to },
              fix
            });
          }
        }
        if (node.name.type === "JSXIdentifier" && isDOMElementName(node.name.name)) {
          const keyProp = jsxGetProp(node.attributes, "key");
          if (keyProp) {
            context.report({
              node: keyProp,
              messageId: "noUselessKey",
              fix: (fixer) => fixer.remove(keyProp)
            });
          }
        }
      }
    };
  }
});

const createRule$7 = ESLintUtils.RuleCreator.withoutDocs;
const knownNamespaces = ["on", "oncapture", "use", "prop", "attr"];
const styleNamespaces = ["style", "class"];
const otherNamespaces = ["xmlns", "xlink"];
const noUnknownNamespaces = createRule$7({
  meta: {
    type: "problem",
    docs: {
      description: "Enforce using only Solid-specific namespaced attribute names (i.e. `'on:'` in `<div on:click={...} />`).",
      url: "https://github.com/solidjs-community/eslint-plugin-solid/blob/main/docs/no-unknown-namespaces.md"
    },
    hasSuggestions: true,
    schema: [
      {
        type: "object",
        properties: {
          allowedNamespaces: {
            description: "an array of additional namespace names to allow",
            type: "array",
            items: {
              type: "string"
            },
            default: [],
            minItems: 1,
            uniqueItems: true
          }
        },
        additionalProperties: false
      }
    ],
    messages: {
      unknown: `'{{namespace}}:' is not one of Solid's special prefixes for JSX attributes (${knownNamespaces.map((n) => `'${n}:'`).join(", ")}).`,
      style: "Using the '{{namespace}}:' special prefix is potentially confusing, prefer the '{{namespace}}' prop instead.",
      component: "Namespaced props have no effect on components.",
      "component-suggest": "Replace {{namespace}}:{{name}} with {{name}}."
    }
  },
  defaultOptions: [],
  create(context) {
    const explicitlyAllowedNamespaces = context.options?.[0]?.allowedNamespaces;
    return {
      "JSXAttribute > JSXNamespacedName": (node) => {
        const openingElement = node.parent.parent;
        if (openingElement.name.type === "JSXIdentifier" && !isDOMElementName(openingElement.name.name)) {
          context.report({
            node,
            messageId: "component",
            suggest: [
              {
                messageId: "component-suggest",
                data: { namespace: node.namespace.name, name: node.name.name },
                fix: (fixer) => fixer.replaceText(node, node.name.name)
              }
            ]
          });
          return;
        }
        const namespace = node.namespace?.name;
        if (!(knownNamespaces.includes(namespace) || otherNamespaces.includes(namespace) || explicitlyAllowedNamespaces?.includes(namespace))) {
          if (styleNamespaces.includes(namespace)) {
            context.report({
              node,
              messageId: "style",
              data: { namespace }
            });
          } else {
            context.report({
              node,
              messageId: "unknown",
              data: { namespace }
            });
          }
        }
      }
    };
  }
});

const createRule$6 = ESLintUtils.RuleCreator.withoutDocs;
const preferClasslist = createRule$6({
  meta: {
    type: "problem",
    docs: {
      description: "Enforce using the classlist prop over importing a classnames helper. The classlist prop accepts an object `{ [class: string]: boolean }` just like classnames.",
      url: "https://github.com/solidjs-community/eslint-plugin-solid/blob/main/docs/prefer-classlist.md"
    },
    fixable: "code",
    schema: [
      {
        type: "object",
        properties: {
          classnames: {
            type: "array",
            description: "An array of names to treat as `classnames` functions",
            default: ["cn", "clsx", "classnames"],
            items: {
              type: "string"
            },
            minItems: 1,
            uniqueItems: true
          }
        },
        additionalProperties: false
      }
    ],
    messages: {
      preferClasslist: "The classlist prop should be used instead of {{ classnames }} to efficiently set classes based on an object."
    },
    deprecated: true
  },
  defaultOptions: [],
  create(context) {
    const classnames = context.options[0]?.classnames ?? ["cn", "clsx", "classnames"];
    return {
      JSXAttribute(node) {
        if (["class", "className"].indexOf(jsxPropName(node)) === -1 || jsxHasProp(
          node.parent?.attributes ?? [],
          "classlist"
        )) {
          return;
        }
        if (node.value?.type === "JSXExpressionContainer") {
          const expr = node.value.expression;
          if (expr.type === "CallExpression" && expr.callee.type === "Identifier" && classnames.indexOf(expr.callee.name) !== -1 && expr.arguments.length === 1 && expr.arguments[0].type === "ObjectExpression") {
            context.report({
              node,
              messageId: "preferClasslist",
              data: {
                classnames: expr.callee.name
              },
              fix: (fixer) => {
                const attrRange = node.range;
                const objectRange = expr.arguments[0].range;
                return [
                  fixer.replaceTextRange([attrRange[0], objectRange[0]], "classlist={"),
                  fixer.replaceTextRange([objectRange[1], attrRange[1]], "}")
                ];
              }
            });
          }
        }
      }
    };
  }
});

const createRule$5 = ESLintUtils.RuleCreator.withoutDocs;
const { getPropertyName: getPropertyName$1 } = ASTUtils;
const preferFor = createRule$5({
  meta: {
    type: "problem",
    docs: {
      description: "Enforce using Solid's `<For />` component for mapping an array to JSX elements.",
      url: "https://github.com/solidjs-community/eslint-plugin-solid/blob/main/docs/prefer-for.md"
    },
    fixable: "code",
    schema: [],
    messages: {
      preferFor: "Use Solid's `<For />` component for efficiently rendering lists. Array#map causes DOM elements to be recreated.",
      preferForOrIndex: "Use Solid's `<For />` component or `<Index />` component for rendering lists. Array#map causes DOM elements to be recreated."
    }
  },
  defaultOptions: [],
  create(context) {
    const reportPreferFor = (node) => {
      const jsxExpressionContainerNode = node.parent;
      const arrayNode = node.callee.object;
      const mapFnNode = node.arguments[0];
      context.report({
        node,
        messageId: "preferFor",
        fix: (fixer) => {
          const beforeArray = [
            jsxExpressionContainerNode.range[0],
            arrayNode.range[0]
          ];
          const betweenArrayAndMapFn = [arrayNode.range[1], mapFnNode.range[0]];
          const afterMapFn = [
            mapFnNode.range[1],
            jsxExpressionContainerNode.range[1]
          ];
          return [
            fixer.replaceTextRange(beforeArray, "<For each={"),
            fixer.replaceTextRange(betweenArrayAndMapFn, "}>{"),
            fixer.replaceTextRange(afterMapFn, "}</For>")
          ];
        }
      });
    };
    return {
      CallExpression(node) {
        const callOrChain = node.parent?.type === "ChainExpression" ? node.parent : node;
        if (callOrChain.parent?.type === "JSXExpressionContainer" && isJSXElementOrFragment(callOrChain.parent.parent)) {
          if (node.callee.type === "MemberExpression" && getPropertyName$1(node.callee) === "map" && node.arguments.length === 1 && // passing thisArg to Array.prototype.map is rare, deopt in that case
          isFunctionNode(node.arguments[0])) {
            const mapFnNode = node.arguments[0];
            if (mapFnNode.params.length === 1 && mapFnNode.params[0].type !== "RestElement") {
              reportPreferFor(node);
            } else {
              context.report({
                node,
                messageId: "preferForOrIndex"
              });
            }
          }
        }
      }
    };
  }
});

const createRule$4 = ESLintUtils.RuleCreator.withoutDocs;
const EXPENSIVE_TYPES = ["JSXElement", "JSXFragment", "Identifier"];
const preferShow = createRule$4({
  meta: {
    type: "problem",
    docs: {
      description: "Enforce using Solid's `<Show />` component for conditionally showing content. Solid's compiler covers this case, so it's a stylistic rule only.",
      url: "https://github.com/solidjs-community/eslint-plugin-solid/blob/main/docs/prefer-show.md"
    },
    fixable: "code",
    schema: [],
    messages: {
      preferShowAnd: "Use Solid's `<Show />` component for conditionally showing content.",
      preferShowTernary: "Use Solid's `<Show />` component for conditionally showing content with a fallback."
    }
  },
  defaultOptions: [],
  create(context) {
    const sourceCode = context.getSourceCode();
    const putIntoJSX = (node) => {
      const text = sourceCode.getText(node);
      return isJSXElementOrFragment(node) ? text : `{${text}}`;
    };
    const logicalExpressionHandler = (node) => {
      if (node.operator === "&&" && EXPENSIVE_TYPES.includes(node.right.type)) {
        context.report({
          node,
          messageId: "preferShowAnd",
          fix: (fixer) => fixer.replaceText(
            node.parent?.type === "JSXExpressionContainer" && isJSXElementOrFragment(node.parent.parent) ? node.parent : node,
            `<Show when={${sourceCode.getText(node.left)}}>${putIntoJSX(node.right)}</Show>`
          )
        });
      }
    };
    const conditionalExpressionHandler = (node) => {
      if (EXPENSIVE_TYPES.includes(node.consequent.type) || EXPENSIVE_TYPES.includes(node.alternate.type)) {
        context.report({
          node,
          messageId: "preferShowTernary",
          fix: (fixer) => fixer.replaceText(
            node.parent?.type === "JSXExpressionContainer" && isJSXElementOrFragment(node.parent.parent) ? node.parent : node,
            `<Show when={${sourceCode.getText(node.test)}} fallback={${sourceCode.getText(
              node.alternate
            )}}>${putIntoJSX(node.consequent)}</Show>`
          )
        });
      }
    };
    return {
      JSXExpressionContainer(node) {
        if (!isJSXElementOrFragment(node.parent)) {
          return;
        }
        if (node.expression.type === "LogicalExpression") {
          logicalExpressionHandler(node.expression);
        } else if (node.expression.type === "ArrowFunctionExpression" && node.expression.body.type === "LogicalExpression") {
          logicalExpressionHandler(node.expression.body);
        } else if (node.expression.type === "ConditionalExpression") {
          conditionalExpressionHandler(node.expression);
        } else if (node.expression.type === "ArrowFunctionExpression" && node.expression.body.type === "ConditionalExpression") {
          conditionalExpressionHandler(node.expression.body);
        }
      }
    };
  }
});

var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => {
  __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
  return value;
};
const { findVariable, getFunctionHeadLocation } = ASTUtils;
const createRule$3 = ESLintUtils.RuleCreator.withoutDocs;
class ScopeStackItem {
  constructor(node) {
    /** the node for the current scope, or program if global scope */
    __publicField(this, "node");
    /**
     * nodes whose descendants in the current scope are allowed to be reactive.
     * JSXExpressionContainers can be any expression containing reactivity, while
     * function nodes/identifiers are typically arguments to solid-js primitives
     * and should match a tracked scope exactly.
     */
    __publicField(this, "trackedScopes", []);
    /** nameless functions with reactivity, should exactly match a tracked scope */
    __publicField(this, "unnamedDerivedSignals", /* @__PURE__ */ new Set());
    /** switched to true by time of :exit if JSX is detected in the current scope */
    __publicField(this, "hasJSX", false);
    this.node = node;
  }
}
class ScopeStack extends Array {
  constructor() {
    super(...arguments);
    __publicField(this, "currentScope", () => this[this.length - 1]);
    __publicField(this, "parentScope", () => this[this.length - 2]);
    /** Function callbacks that run synchronously and don't create a new scope. */
    __publicField(this, "syncCallbacks", /* @__PURE__ */ new Set());
    /** Returns the function node deepest in the tree. Assumes a === b, a is inside b, or b is inside a. */
    __publicField(this, "findDeepestDeclarationScope", (a, b) => {
      if (a === b)
        return a;
      for (let i = this.length - 1; i >= 0; i -= 1) {
        const { node } = this[i];
        if (a === node || b === node) {
          return node;
        }
      }
      throw new Error("This should never happen");
    });
    /** variable references to be treated as signals, memos, derived signals, etc. */
    __publicField(this, "signals", []);
    /** variables references to be treated as props (or stores) */
    __publicField(this, "props", []);
  }
  /** Add references to a signal, memo, derived signal, etc. */
  pushSignal(variable, declarationScope = this.currentScope().node) {
    this.signals.push({
      references: variable.references.filter((reference) => !reference.init),
      variable,
      declarationScope
    });
  }
  /**
   * Add references to a signal, merging with existing references if the
   * variable is the same. Derived signals are special; they don't use the
   * declaration scope of the function, but rather the minimum declaration scope
   * of any signals they contain.
   */
  pushUniqueSignal(variable, declarationScope) {
    const foundSignal = this.signals.find((s) => s.variable === variable);
    if (!foundSignal) {
      this.pushSignal(variable, declarationScope);
    } else {
      foundSignal.declarationScope = this.findDeepestDeclarationScope(
        foundSignal.declarationScope,
        declarationScope
      );
    }
  }
  /** Add references to a props or store. */
  pushProps(variable, declarationScope = this.currentScope().node) {
    this.props.push({
      references: variable.references.filter((reference) => !reference.init),
      variable,
      declarationScope
    });
  }
  /**
   * Iterate through and remove the signal references in the current scope.
   * That way, the next Scope up can safely check for references in its scope.
   */
  *consumeSignalReferencesInScope() {
    yield* this.consumeReferencesInScope(this.signals);
    this.signals = this.signals.filter((variable) => variable.references.length !== 0);
  }
  /** Iterate through and remove the props references in the current scope. */
  *consumePropsReferencesInScope() {
    yield* this.consumeReferencesInScope(this.props);
    this.props = this.props.filter((variable) => variable.references.length !== 0);
  }
  *consumeReferencesInScope(variables) {
    for (const variable of variables) {
      const { references } = variable;
      const inScope = [], notInScope = [];
      references.forEach((reference) => {
        if (this.isReferenceInCurrentScope(reference)) {
          inScope.push(reference);
        } else {
          notInScope.push(reference);
        }
      });
      yield* inScope.map((reference) => ({
        reference,
        declarationScope: variable.declarationScope
      }));
      variable.references = notInScope;
    }
  }
  /**
   * Returns true if the reference is in the current scope, handling sync
   * callbacks. Must be called on the :exit pass only.
   */
  isReferenceInCurrentScope(reference) {
    let parentFunction = findParent(reference.identifier, isProgramOrFunctionNode);
    while (isFunctionNode(parentFunction) && this.syncCallbacks.has(parentFunction)) {
      parentFunction = findParent(parentFunction, isProgramOrFunctionNode);
    }
    return parentFunction === this.currentScope().node;
  }
}
const getNthDestructuredVar = (id, n, scope) => {
  if (id?.type === "ArrayPattern") {
    const el = id.elements[n];
    if (el?.type === "Identifier") {
      return findVariable(scope, el.name);
    }
  }
  return null;
};
const getReturnedVar = (id, scope) => {
  if (id.type === "Identifier") {
    return findVariable(scope, id.name);
  }
  return null;
};
const reactivity = createRule$3({
  meta: {
    type: "problem",
    docs: {
      description: "Enforce that reactivity (props, signals, memos, etc.) is properly used, so changes in those values will be tracked and update the view as expected.",
      url: "https://github.com/solidjs-community/eslint-plugin-solid/blob/main/docs/reactivity.md"
    },
    schema: [
      {
        type: "object",
        properties: {
          customReactiveFunctions: {
            description: "List of function names to consider as reactive functions (allow signals to be safely passed as arguments). In addition, any create* or use* functions are automatically included.",
            type: "array",
            items: {
              type: "string"
            },
            default: []
          }
        },
        additionalProperties: false
      }
    ],
    messages: {
      noWrite: "The reactive variable '{{name}}' should not be reassigned or altered directly.",
      untrackedReactive: "The reactive variable '{{name}}' should be used within JSX, a tracked scope (like createEffect), or inside an event handler function, or else changes will be ignored.",
      expectedFunctionGotExpression: "The reactive variable '{{name}}' should be wrapped in a function for reactivity. This includes event handler bindings on native elements, which are not reactive like other JSX props.",
      badSignal: "The reactive variable '{{name}}' should be called as a function when used in {{where}}.",
      badUnnamedDerivedSignal: "This function should be passed to a tracked scope (like createEffect) or an event handler because it contains reactivity, or else changes will be ignored.",
      shouldDestructure: "For proper analysis, array destructuring should be used to capture the {{nth}}result of this function call.",
      shouldAssign: "For proper analysis, a variable should be used to capture the result of this function call.",
      noAsyncTrackedScope: "This tracked scope should not be async. Solid's reactivity only tracks synchronously."
    }
  },
  defaultOptions: [
    {
      customReactiveFunctions: []
    }
  ],
  create(context, [options]) {
    const warnShouldDestructure = (node, nth) => context.report({
      node,
      messageId: "shouldDestructure",
      data: nth ? { nth: nth + " " } : void 0
    });
    const warnShouldAssign = (node) => context.report({ node, messageId: "shouldAssign" });
    const sourceCode = context.getSourceCode();
    const scopeStack = new ScopeStack();
    const { currentScope, parentScope } = scopeStack;
    const { matchImport, handleImportDeclaration } = trackImports();
    const markPropsOnCondition = (node, cb) => {
      if (node.params.length === 1 && node.params[0].type === "Identifier" && node.parent?.type !== "JSXExpressionContainer" && // "render props" aren't components
      node.parent?.type !== "TemplateLiteral" && // inline functions in tagged template literals aren't components
      cb(node.params[0])) {
        const propsParam = findVariable(context.getScope(), node.params[0]);
        if (propsParam) {
          scopeStack.pushProps(propsParam, node);
        }
      }
    };
    const onFunctionEnter = (node) => {
      if (isFunctionNode(node)) {
        if (scopeStack.syncCallbacks.has(node)) {
          return;
        }
        markPropsOnCondition(node, (props) => isPropsByName(props.name));
      }
      scopeStack.push(new ScopeStackItem(node));
    };
    const matchTrackedScope = (trackedScope, node) => {
      switch (trackedScope.expect) {
        case "function":
        case "called-function":
          return node === trackedScope.node;
        case "expression":
          return Boolean(
            findInScope(node, currentScope().node, (node2) => node2 === trackedScope.node)
          );
      }
    };
    const handleTrackedScopes = (identifier, declarationScope) => {
      const currentScopeNode = currentScope().node;
      if (!currentScope().trackedScopes.find(
        (trackedScope) => matchTrackedScope(trackedScope, identifier)
      )) {
        const matchedExpression = currentScope().trackedScopes.find(
          (trackedScope) => matchTrackedScope({ ...trackedScope, expect: "expression" }, identifier)
        );
        if (declarationScope === currentScopeNode) {
          let parentMemberExpression = null;
          if (identifier.parent?.type === "MemberExpression") {
            parentMemberExpression = identifier.parent;
            while (parentMemberExpression.parent?.type === "MemberExpression") {
              parentMemberExpression = parentMemberExpression.parent;
            }
          }
          const parentCallExpression = identifier.parent?.type === "CallExpression" ? identifier.parent : null;
          context.report({
            node: parentMemberExpression ?? parentCallExpression ?? identifier,
            messageId: matchedExpression ? "expectedFunctionGotExpression" : "untrackedReactive",
            data: {
              name: parentMemberExpression ? sourceCode.getText(parentMemberExpression) : identifier.name
            }
          });
        } else {
          if (!parentScope() || !isFunctionNode(currentScopeNode)) {
            throw new Error("this shouldn't happen!");
          }
          const pushUnnamedDerivedSignal = () => {
            var _a;
            return ((_a = parentScope()).unnamedDerivedSignals ?? (_a.unnamedDerivedSignals = /* @__PURE__ */ new Set())).add(currentScopeNode);
          };
          if (currentScopeNode.type === "FunctionDeclaration") {
            const functionVariable = sourceCode.scopeManager?.getDeclaredVariables(currentScopeNode)?.[0];
            if (functionVariable) {
              scopeStack.pushUniqueSignal(
                functionVariable,
                declarationScope
                // use declaration scope of a signal contained in this function
              );
            } else {
              pushUnnamedDerivedSignal();
            }
          } else if (currentScopeNode.parent?.type === "VariableDeclarator") {
            const declarator = currentScopeNode.parent;
            const functionVariable = sourceCode.scopeManager?.getDeclaredVariables(declarator)?.[0];
            if (functionVariable) {
              scopeStack.pushUniqueSignal(functionVariable, declarationScope);
            } else {
              pushUnnamedDerivedSignal();
            }
          } else if (currentScopeNode.parent?.type === "Property") ; else {
            pushUnnamedDerivedSignal();
          }
        }
      }
    };
    const onFunctionExit = (currentScopeNode) => {
      if (isFunctionNode(currentScopeNode)) {
        markPropsOnCondition(currentScopeNode, (props) => {
          if (!isPropsByName(props.name) && // already added in markPropsOnEnter
          currentScope().hasJSX) {
            const functionName = getFunctionName(currentScopeNode);
            if (functionName && !/^[a-z]/.test(functionName))
              return true;
          }
          return false;
        });
      }
      if (isFunctionNode(currentScopeNode) && scopeStack.syncCallbacks.has(currentScopeNode)) {
        return;
      }
      for (const { reference, declarationScope } of scopeStack.consumeSignalReferencesInScope()) {
        const identifier = reference.identifier;
        if (reference.isWrite()) {
          context.report({
            node: identifier,
            messageId: "noWrite",
            data: {
              name: identifier.name
            }
          });
        } else if (identifier.type === "Identifier") {
          const reportBadSignal = (where) => context.report({
            node: identifier,
            messageId: "badSignal",
            data: { name: identifier.name, where }
          });
          if (
            // This allows both calling a signal and calling a function with a signal.
            identifier.parent?.type === "CallExpression" || // Also allow the case where we pass an array of signals, such as in a custom hook
            identifier.parent?.type === "ArrayExpression" && identifier.parent.parent?.type === "CallExpression"
          ) {
            handleTrackedScopes(identifier, declarationScope);
          } else if (identifier.parent?.type === "TemplateLiteral") {
            reportBadSignal("template literals");
          } else if (identifier.parent?.type === "BinaryExpression" && [
            "<",
            "<=",
            ">",
            ">=",
            "<<",
            ">>",
            ">>>",
            "+",
            "-",
            "*",
            "/",
            "%",
            "**",
            "|",
            "^",
            "&",
            "in"
          ].includes(identifier.parent.operator)) {
            reportBadSignal("arithmetic or comparisons");
          } else if (identifier.parent?.type === "UnaryExpression" && ["-", "+", "~"].includes(identifier.parent.operator)) {
            reportBadSignal("unary expressions");
          } else if (identifier.parent?.type === "MemberExpression" && identifier.parent.computed && identifier.parent.property === identifier) {
            reportBadSignal("property accesses");
          } else if (identifier.parent?.type === "JSXExpressionContainer" && !currentScope().trackedScopes.find(
            (trackedScope) => trackedScope.node === identifier && (trackedScope.expect === "function" || trackedScope.expect === "called-function")
          )) {
            const elementOrAttribute = identifier.parent.parent;
            if (
              // The signal is not being called and is being used as a props.children, where calling
              // the signal was the likely intent.
              isJSXElementOrFragment(elementOrAttribute) || // We can't say for sure about user components, but we know for a fact that a signal
              // should not be passed to a non-event handler DOM element attribute without calling it.
              elementOrAttribute?.type === "JSXAttribute" && elementOrAttribute.parent?.type === "JSXOpeningElement" && elementOrAttribute.parent.name.type === "JSXIdentifier" && isDOMElementName(elementOrAttribute.parent.name.name)
            ) {
              reportBadSignal("JSX");
            }
          }
        }
      }
      for (const { reference, declarationScope } of scopeStack.consumePropsReferencesInScope()) {
        const identifier = reference.identifier;
        if (reference.isWrite()) {
          context.report({
            node: identifier,
            messageId: "noWrite",
            data: {
              name: identifier.name
            }
          });
        } else if (identifier.parent?.type === "MemberExpression" && identifier.parent.object === identifier) {
          const { parent } = identifier;
          if (parent.parent?.type === "AssignmentExpression" && parent.parent.left === parent) {
            context.report({
              node: identifier,
              messageId: "noWrite",
              data: {
                name: identifier.name
              }
            });
          } else if (parent.property.type === "Identifier" && /^(?:initial|default|static)[A-Z]/.test(parent.property.name)) ; else {
            handleTrackedScopes(identifier, declarationScope);
          }
        } else if (identifier.parent?.type === "AssignmentExpression" || identifier.parent?.type === "VariableDeclarator") {
          context.report({
            node: identifier,
            messageId: "untrackedReactive",
            data: { name: identifier.name }
          });
        }
      }
      const { unnamedDerivedSignals } = currentScope();
      if (unnamedDerivedSignals) {
        for (const node of unnamedDerivedSignals) {
          if (!currentScope().trackedScopes.find(
            (trackedScope) => matchTrackedScope(trackedScope, node)
          )) {
            context.report({
              loc: getFunctionHeadLocation(node, sourceCode),
              messageId: "badUnnamedDerivedSignal"
            });
          }
        }
      }
      scopeStack.pop();
    };
    const checkForSyncCallbacks = (node) => {
      if (node.arguments.length === 1 && isFunctionNode(node.arguments[0]) && !node.arguments[0].async) {
        if (node.callee.type === "Identifier" && matchImport(["batch", "produce"], node.callee.name)) {
          scopeStack.syncCallbacks.add(node.arguments[0]);
        } else if (node.callee.type === "MemberExpression" && !node.callee.computed && node.callee.object.type !== "ObjectExpression" && /^(?:forEach|map|flatMap|reduce|reduceRight|find|findIndex|filter|every|some)$/.test(
          node.callee.property.name
        )) {
          scopeStack.syncCallbacks.add(node.arguments[0]);
        }
      }
      if (node.callee.type === "Identifier") {
        if (matchImport(["createSignal", "createStore"], node.callee.name) && node.parent?.type === "VariableDeclarator") {
          const setter = getNthDestructuredVar(node.parent.id, 1, context.getScope());
          if (setter) {
            for (const reference of setter.references) {
              const { identifier } = reference;
              if (!reference.init && reference.isRead() && identifier.parent?.type === "CallExpression") {
                for (const arg of identifier.parent.arguments) {
                  if (isFunctionNode(arg) && !arg.async) {
                    scopeStack.syncCallbacks.add(arg);
                  }
                }
              }
            }
          }
        } else if (matchImport(["mapArray", "indexArray"], node.callee.name)) {
          const arg1 = node.arguments[1];
          if (isFunctionNode(arg1)) {
            scopeStack.syncCallbacks.add(arg1);
          }
        }
      }
      if (isFunctionNode(node.callee)) {
        scopeStack.syncCallbacks.add(node.callee);
      }
    };
    const checkForReactiveAssignment = (id, init) => {
      init = ignoreTransparentWrappers(init);
      if (init.type === "CallExpression" && init.callee.type === "Identifier") {
        const { callee } = init;
        if (matchImport(["createSignal", "useTransition"], callee.name)) {
          const signal = id && getNthDestructuredVar(id, 0, context.getScope());
          if (signal) {
            scopeStack.pushSignal(signal, currentScope().node);
          } else {
            warnShouldDestructure(id ?? init, "first");
          }
        } else if (matchImport(["createMemo", "createSelector"], callee.name)) {
          const memo = id && getReturnedVar(id, context.getScope());
          if (memo) {
            scopeStack.pushSignal(memo, currentScope().node);
          } else {
            warnShouldAssign(id ?? init);
          }
        } else if (matchImport("createStore", callee.name)) {
          const store = id && getNthDestructuredVar(id, 0, context.getScope());
          if (store) {
            scopeStack.pushProps(store, currentScope().node);
          } else {
            warnShouldDestructure(id ?? init, "first");
          }
        } else if (matchImport("mergeProps", callee.name)) {
          const merged = id && getReturnedVar(id, context.getScope());
          if (merged) {
            scopeStack.pushProps(merged, currentScope().node);
          } else {
            warnShouldAssign(id ?? init);
          }
        } else if (matchImport("splitProps", callee.name)) {
          if (id?.type === "ArrayPattern") {
            const vars = id.elements.map((_, i) => getNthDestructuredVar(id, i, context.getScope())).filter(Boolean);
            if (vars.length === 0) {
              warnShouldDestructure(id);
            } else {
              vars.forEach((variable) => {
                scopeStack.pushProps(variable, currentScope().node);
              });
            }
          } else {
            const vars = id && getReturnedVar(id, context.getScope());
            if (vars) {
              scopeStack.pushProps(vars, currentScope().node);
            }
          }
        } else if (matchImport("createResource", callee.name)) {
          const resourceReturn = id && getNthDestructuredVar(id, 0, context.getScope());
          if (resourceReturn) {
            scopeStack.pushProps(resourceReturn, currentScope().node);
          }
        } else if (matchImport("createMutable", callee.name)) {
          const mutable = id && getReturnedVar(id, context.getScope());
          if (mutable) {
            scopeStack.pushProps(mutable, currentScope().node);
          }
        } else if (matchImport("mapArray", callee.name)) {
          const arg1 = init.arguments[1];
          if (isFunctionNode(arg1) && arg1.params.length >= 2 && arg1.params[1].type === "Identifier") {
            const indexSignal = findVariable(context.getScope(), arg1.params[1]);
            if (indexSignal) {
              scopeStack.pushSignal(indexSignal);
            }
          }
        } else if (matchImport("indexArray", callee.name)) {
          const arg1 = init.arguments[1];
          if (isFunctionNode(arg1) && arg1.params.length >= 1 && arg1.params[0].type === "Identifier") {
            const valueSignal = findVariable(context.getScope(), arg1.params[0]);
            if (valueSignal) {
              scopeStack.pushSignal(valueSignal);
            }
          }
        }
      }
    };
    const checkForTrackedScopes = (node) => {
      const pushTrackedScope = (node2, expect) => {
        currentScope().trackedScopes.push({ node: node2, expect });
        if (expect !== "called-function" && isFunctionNode(node2) && node2.async) {
          context.report({
            node: node2,
            messageId: "noAsyncTrackedScope"
          });
        }
      };
      const permissivelyTrackNode = (node2) => {
        traverse(node2, {
          enter(cn) {
            const childNode = cn;
            const traced = trace(childNode, context.getScope());
            if (isFunctionNode(traced) || traced.type === "Identifier" && traced.parent.type !== "MemberExpression" && !(traced.parent.type === "CallExpression" && traced.parent.callee === traced)) {
              pushTrackedScope(childNode, "called-function");
              this.skip();
            }
          }
        });
      };
      if (node.type === "JSXExpressionContainer") {
        if (node.parent?.type === "JSXAttribute" && /^on[:A-Z]/.test(sourceCode.getText(node.parent.name)) && node.parent.parent?.type === "JSXOpeningElement" && node.parent.parent.name.type === "JSXIdentifier" && isDOMElementName(node.parent.parent.name.name)) {
          pushTrackedScope(node.expression, "called-function");
        } else if (node.parent?.type === "JSXAttribute" && node.parent.name.type === "JSXNamespacedName" && node.parent.name.namespace.name === "use" && isFunctionNode(node.expression)) {
          pushTrackedScope(node.expression, "called-function");
        } else if (node.parent?.type === "JSXAttribute" && node.parent.name.name === "value" && node.parent.parent?.type === "JSXOpeningElement" && (node.parent.parent.name.type === "JSXIdentifier" && node.parent.parent.name.name.endsWith("Provider") || node.parent.parent.name.type === "JSXMemberExpression" && node.parent.parent.name.property.name === "Provider")) ; else if (node.parent?.type === "JSXAttribute" && node.parent.name?.type === "JSXIdentifier" && /^static[A-Z]/.test(node.parent.name.name) && node.parent.parent?.type === "JSXOpeningElement" && node.parent.parent.name.type === "JSXIdentifier" && !isDOMElementName(node.parent.parent.name.name)) ; else if (node.parent?.type === "JSXAttribute" && node.parent.name.name === "ref" && isFunctionNode(node.expression)) {
          pushTrackedScope(node.expression, "called-function");
        } else if (isJSXElementOrFragment(node.parent) && isFunctionNode(node.expression)) {
          pushTrackedScope(node.expression, "function");
        } else {
          pushTrackedScope(node.expression, "expression");
        }
      } else if (node.type === "JSXSpreadAttribute") {
        pushTrackedScope(node.argument, "expression");
      } else if (node.type === "NewExpression") {
        const {
          callee,
          arguments: { 0: arg0 }
        } = node;
        if (callee.type === "Identifier" && arg0 && // Observers from Standard Web APIs
        [
          "IntersectionObserver",
          "MutationObserver",
          "PerformanceObserver",
          "ReportingObserver",
          "ResizeObserver"
        ].includes(callee.name)) {
          pushTrackedScope(arg0, "called-function");
        }
      } else if (node.type === "CallExpression") {
        if (node.callee.type === "Identifier") {
          const {
            callee,
            arguments: { 0: arg0, 1: arg1 }
          } = node;
          if (matchImport(
            [
              "createMemo",
              "children",
              "createEffect",
              "createRenderEffect",
              "createDeferred",
              "createComputed",
              "createSelector",
              "untrack",
              "mapArray",
              "indexArray",
              "observable"
            ],
            callee.name
          ) || matchImport("createResource", callee.name) && node.arguments.length >= 2) {
            pushTrackedScope(arg0, "function");
          } else if (matchImport(["onMount", "onCleanup", "onError"], callee.name) || [
            // Timers
            "setInterval",
            "setTimeout",
            "setImmediate",
            "requestAnimationFrame",
            "requestIdleCallback"
          ].includes(callee.name)) {
            pushTrackedScope(arg0, "called-function");
          } else if (matchImport("on", callee.name)) {
            if (arg0) {
              if (arg0.type === "ArrayExpression") {
                arg0.elements.forEach((element) => {
                  if (element && element?.type !== "SpreadElement") {
                    pushTrackedScope(element, "function");
                  }
                });
              } else {
                pushTrackedScope(arg0, "function");
              }
            }
            if (arg1) {
              pushTrackedScope(arg1, "called-function");
            }
          } else if (matchImport("createStore", callee.name) && arg0?.type === "ObjectExpression") {
            for (const property of arg0.properties) {
              if (property.type === "Property" && property.kind === "get" && isFunctionNode(property.value)) {
                pushTrackedScope(property.value, "function");
              }
            }
          } else if (matchImport("runWithOwner", callee.name)) {
            if (arg1) {
              let isTrackedScope = true;
              const owner = arg0.type === "Identifier" && findVariable(context.getScope(), arg0);
              if (owner) {
                const decl = owner.defs[0];
                if (decl && decl.node.type === "VariableDeclarator" && decl.node.init?.type === "CallExpression" && decl.node.init.callee.type === "Identifier" && matchImport("getOwner", decl.node.init.callee.name)) {
                  const ownerFunction = findParent(decl.node, isProgramOrFunctionNode);
                  const scopeStackIndex = scopeStack.findIndex(
                    ({ node: node2 }) => ownerFunction === node2
                  );
                  if (scopeStackIndex >= 1 && !scopeStack[scopeStackIndex - 1].trackedScopes.some(
                    (trackedScope) => trackedScope.expect === "function" && trackedScope.node === ownerFunction
                  ) || scopeStackIndex === 0) {
                    isTrackedScope = false;
                  }
                }
              }
              if (isTrackedScope) {
                pushTrackedScope(arg1, "function");
              }
            }
          } else if (/^(?:use|create)[A-Z]/.test(callee.name) || options.customReactiveFunctions.includes(callee.name)) {
            for (const arg of node.arguments) {
              permissivelyTrackNode(arg);
            }
          }
        } else if (node.callee.type === "MemberExpression") {
          const { property } = node.callee;
          if (property.type === "Identifier" && property.name === "addEventListener" && node.arguments.length >= 2) {
            pushTrackedScope(node.arguments[1], "called-function");
          } else if (property.type === "Identifier" && (/^(?:use|create)[A-Z]/.test(property.name) || options.customReactiveFunctions.includes(property.name))) {
            for (const arg of node.arguments) {
              permissivelyTrackNode(arg);
            }
          }
        }
      } else if (node.type === "VariableDeclarator") {
        if (node.init?.type === "CallExpression" && node.init.callee.type === "Identifier") {
          if (matchImport(["createReactive", "createReaction"], node.init.callee.name)) {
            const track = getReturnedVar(node.id, context.getScope());
            if (track) {
              for (const reference of track.references) {
                if (!reference.init && reference.isReadOnly() && reference.identifier.parent?.type === "CallExpression" && reference.identifier.parent.callee === reference.identifier) {
                  const arg0 = reference.identifier.parent.arguments[0];
                  arg0 && pushTrackedScope(arg0, "function");
                }
              }
            }
            if (isFunctionNode(node.init.arguments[0])) {
              pushTrackedScope(node.init.arguments[0], "called-function");
            }
          }
        }
      } else if (node.type === "AssignmentExpression") {
        if (node.left.type === "MemberExpression" && node.left.property.type === "Identifier" && isFunctionNode(node.right) && /^on[a-z]+$/.test(node.left.property.name)) {
          pushTrackedScope(node.right, "called-function");
        }
      } else if (node.type === "TaggedTemplateExpression") {
        for (const expression of node.quasi.expressions) {
          if (isFunctionNode(expression)) {
            pushTrackedScope(expression, "called-function");
            for (const param of expression.params) {
              if (param.type === "Identifier" && isPropsByName(param.name)) {
                const variable = findVariable(context.getScope(), param);
                if (variable)
                  scopeStack.pushProps(variable, currentScope().node);
              }
            }
          }
        }
      }
    };
    return {
      ImportDeclaration: handleImportDeclaration,
      JSXExpressionContainer(node) {
        checkForTrackedScopes(node);
      },
      JSXSpreadAttribute(node) {
        checkForTrackedScopes(node);
      },
      CallExpression(node) {
        checkForTrackedScopes(node);
        checkForSyncCallbacks(node);
        const parent = node.parent && ignoreTransparentWrappers(node.parent, true);
        if (parent?.type !== "AssignmentExpression" && parent?.type !== "VariableDeclarator") {
          checkForReactiveAssignment(null, node);
        }
      },
      NewExpression(node) {
        checkForTrackedScopes(node);
      },
      VariableDeclarator(node) {
        if (node.init) {
          checkForReactiveAssignment(node.id, node.init);
          checkForTrackedScopes(node);
        }
      },
      AssignmentExpression(node) {
        if (node.left.type !== "MemberExpression") {
          checkForReactiveAssignment(node.left, node.right);
        }
        checkForTrackedScopes(node);
      },
      TaggedTemplateExpression(node) {
        checkForTrackedScopes(node);
      },
      "JSXElement > JSXExpressionContainer > :function"(node) {
        if (isFunctionNode(node) && node.parent?.type === "JSXExpressionContainer" && node.parent.parent?.type === "JSXElement") {
          const element = node.parent.parent;
          if (element.openingElement.name.type === "JSXIdentifier") {
            const tagName = element.openingElement.name.name;
            if (matchImport("For", tagName) && node.params.length === 2 && node.params[1].type === "Identifier") {
              const index = findVariable(context.getScope(), node.params[1]);
              if (index) {
                scopeStack.pushSignal(index, currentScope().node);
              }
            } else if (matchImport("Index", tagName) && node.params.length >= 1 && node.params[0].type === "Identifier") {
              const item = findVariable(context.getScope(), node.params[0]);
              if (item) {
                scopeStack.pushSignal(item, currentScope().node);
              }
            }
          }
        }
      },
      /* Function enter/exit */
      FunctionExpression: onFunctionEnter,
      ArrowFunctionExpression: onFunctionEnter,
      FunctionDeclaration: onFunctionEnter,
      Program: onFunctionEnter,
      "FunctionExpression:exit": onFunctionExit,
      "ArrowFunctionExpression:exit": onFunctionExit,
      "FunctionDeclaration:exit": onFunctionExit,
      "Program:exit": onFunctionExit,
      /* Detect JSX for adding props */
      JSXElement() {
        if (scopeStack.length) {
          currentScope().hasJSX = true;
        }
      },
      JSXFragment() {
        if (scopeStack.length) {
          currentScope().hasJSX = true;
        }
      }
    };
  }
});

const createRule$2 = ESLintUtils.RuleCreator.withoutDocs;
function isComponent(node) {
  return node.name.type === "JSXIdentifier" && !isDOMElementName(node.name.name) || node.name.type === "JSXMemberExpression";
}
const voidDOMElementRegex = /^(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/;
function isVoidDOMElementName(name) {
  return voidDOMElementRegex.test(name);
}
function childrenIsEmpty(node) {
  return node.parent.children.length === 0;
}
function childrenIsMultilineSpaces(node) {
  const childrens = node.parent.children;
  return childrens.length === 1 && childrens[0].type === "JSXText" && childrens[0].value.indexOf("\n") !== -1 && childrens[0].value.replace(/(?!\xA0)\s/g, "") === "";
}
const selfClosingComp = createRule$2({
  meta: {
    type: "layout",
    docs: {
      description: "Disallow extra closing tags for components without children.",
      url: "https://github.com/solidjs-community/eslint-plugin-solid/blob/main/docs/self-closing-comp.md"
    },
    fixable: "code",
    schema: [
      {
        type: "object",
        properties: {
          component: {
            type: "string",
            description: "which Solid components should be self-closing when possible",
            enum: ["all", "none"],
            default: "all"
          },
          html: {
            type: "string",
            description: "which native elements should be self-closing when possible",
            enum: ["all", "void", "none"],
            default: "all"
          }
        },
        additionalProperties: false
      }
    ],
    messages: {
      selfClose: "Empty components are self-closing.",
      dontSelfClose: "This element should not be self-closing."
    }
  },
  defaultOptions: [],
  create(context) {
    function shouldBeSelfClosedWhenPossible(node) {
      if (isComponent(node)) {
        const whichComponents = context.options[0]?.component ?? "all";
        return whichComponents === "all";
      } else if (node.name.type === "JSXIdentifier" && isDOMElementName(node.name.name)) {
        const whichComponents = context.options[0]?.html ?? "all";
        switch (whichComponents) {
          case "all":
            return true;
          case "void":
            return isVoidDOMElementName(node.name.name);
          case "none":
            return false;
        }
      }
      return true;
    }
    return {
      JSXOpeningElement(node) {
        const canSelfClose = childrenIsEmpty(node) || childrenIsMultilineSpaces(node);
        if (canSelfClose) {
          const shouldSelfClose = shouldBeSelfClosedWhenPossible(node);
          if (shouldSelfClose && !node.selfClosing) {
            context.report({
              node,
              messageId: "selfClose",
              fix(fixer) {
                const openingElementEnding = node.range[1] - 1;
                const closingElementEnding = node.parent.closingElement.range[1];
                const range = [openingElementEnding, closingElementEnding];
                return fixer.replaceTextRange(range, " />");
              }
            });
          } else if (!shouldSelfClose && node.selfClosing) {
            context.report({
              node,
              messageId: "dontSelfClose",
              fix(fixer) {
                const sourceCode = context.getSourceCode();
                const tagName = context.getSourceCode().getText(node.name);
                const selfCloseEnding = node.range[1];
                const lastTokens = sourceCode.getLastTokens(node, { count: 3 });
                const isSpaceBeforeSelfClose = sourceCode.isSpaceBetween?.(
                  lastTokens[0],
                  lastTokens[1]
                );
                const range = [
                  isSpaceBeforeSelfClose ? selfCloseEnding - 3 : selfCloseEnding - 2,
                  selfCloseEnding
                ];
                return fixer.replaceTextRange(range, `></${tagName}>`);
              }
            });
          }
        }
      }
    };
  }
});

const createRule$1 = ESLintUtils.RuleCreator.withoutDocs;
const { getPropertyName, getStaticValue } = ASTUtils;
const lengthPercentageRegex = /\b(?:width|height|margin|padding|border-width|font-size)\b/i;
const styleProp = createRule$1({
  meta: {
    type: "problem",
    docs: {
      description: "Require CSS properties in the `style` prop to be valid and kebab-cased (ex. 'font-size'), not camel-cased (ex. 'fontSize') like in React, and that property values with dimensions are strings, not numbers with implicit 'px' units.",
      url: "https://github.com/solidjs-community/eslint-plugin-solid/blob/main/docs/style-prop.md"
    },
    fixable: "code",
    schema: [
      {
        type: "object",
        properties: {
          styleProps: {
            description: "an array of prop names to treat as a CSS style object",
            default: ["style"],
            type: "array",
            items: {
              type: "string"
            },
            minItems: 1,
            uniqueItems: true
          },
          allowString: {
            description: "if allowString is set to true, this rule will not convert a style string literal into a style object (not recommended for performance)",
            type: "boolean",
            default: false
          }
        },
        additionalProperties: false
      }
    ],
    messages: {
      kebabStyleProp: "Use {{ kebabName }} instead of {{ name }}.",
      invalidStyleProp: "{{ name }} is not a valid CSS property.",
      numericStyleValue: 'This CSS property value should be a string with a unit; Solid does not automatically append a "px" unit.',
      stringStyle: "Use an object for the style prop instead of a string."
    }
  },
  defaultOptions: [],
  create(context) {
    const allCssPropertiesSet = new Set(all);
    const allowString = Boolean(context.options[0]?.allowString);
    const styleProps = context.options[0]?.styleProps || ["style"];
    return {
      JSXAttribute(node) {
        if (styleProps.indexOf(jsxPropName(node)) === -1) {
          return;
        }
        const style = node.value?.type === "JSXExpressionContainer" ? node.value.expression : node.value;
        if (!style) {
          return;
        } else if (style.type === "Literal" && typeof style.value === "string" && !allowString) {
          let objectStyles;
          try {
            objectStyles = parse(style.value) ?? void 0;
          } catch (e) {
          }
          context.report({
            node: style,
            messageId: "stringStyle",
            // replace full prop value, wrap in JSXExpressionContainer, more fixes may be applied below
            fix: objectStyles && ((fixer) => fixer.replaceText(node.value, `{${JSON.stringify(objectStyles)}}`))
          });
        } else if (style.type === "TemplateLiteral" && !allowString) {
          context.report({
            node: style,
            messageId: "stringStyle"
          });
        } else if (style.type === "ObjectExpression") {
          const properties = style.properties.filter(
            (prop) => prop.type === "Property"
          );
          properties.forEach((prop) => {
            const name = getPropertyName(prop, context.getScope());
            if (name && !name.startsWith("--") && !allCssPropertiesSet.has(name)) {
              const kebabName = kebabCase(name);
              if (allCssPropertiesSet.has(kebabName)) {
                context.report({
                  node: prop.key,
                  messageId: "kebabStyleProp",
                  data: { name, kebabName },
                  fix: (fixer) => fixer.replaceText(prop.key, `"${kebabName}"`)
                  // wrap kebab name in quotes to be a valid object key
                });
              } else {
                context.report({
                  node: prop.key,
                  messageId: "invalidStyleProp",
                  data: { name }
                });
              }
            } else if (!name || !name.startsWith("--") && lengthPercentageRegex.test(name)) {
              const value = getStaticValue(prop.value)?.value;
              if (typeof value === "number" && value !== 0) {
                context.report({ node: prop.value, messageId: "numericStyleValue" });
              }
            }
          });
        }
      }
    };
  }
});

const createRule = ESLintUtils.RuleCreator.withoutDocs;
const noArrayHandlers = createRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow usage of type-unsafe event handlers.",
      url: "https://github.com/solidjs-community/eslint-plugin-solid/blob/main/docs/no-array-handlers.md"
    },
    schema: [],
    messages: {
      noArrayHandlers: "Passing an array as an event handler is potentially type-unsafe."
    }
  },
  defaultOptions: [],
  create(context) {
    return {
      JSXAttribute(node) {
        const openingElement = node.parent;
        if (openingElement.name.type !== "JSXIdentifier" || !isDOMElementName(openingElement.name.name)) {
          return;
        }
        const isNamespacedHandler = node.name.type === "JSXNamespacedName" && node.name.namespace.name === "on";
        const isNormalEventHandler = node.name.type === "JSXIdentifier" && /^on[a-zA-Z]/.test(node.name.name);
        if ((isNamespacedHandler || isNormalEventHandler) && node.value?.type === "JSXExpressionContainer" && trace(node.value.expression, context.getScope()).type === "ArrayExpression") {
          context.report({
            node,
            messageId: "noArrayHandlers"
          });
        }
      }
    };
  }
});

const rules = {
  "components-return-once": componentsReturnOnce,
  "event-handlers": eventHandlers,
  imports,
  "jsx-no-duplicate-props": jsxNoDuplicateProps,
  "jsx-no-undef": jsxNoUndef,
  "jsx-no-script-url": jsxNoScriptUrl,
  "jsx-uses-vars": jsxUsesVars,
  "no-destructure": noDestructure,
  "no-innerhtml": noInnerHTML,
  "no-proxy-apis": noProxyApis,
  "no-react-deps": noReactDeps,
  "no-react-specific-props": noReactSpecificProps,
  "no-unknown-namespaces": noUnknownNamespaces,
  "prefer-classlist": preferClasslist,
  "prefer-for": preferFor,
  "prefer-show": preferShow,
  reactivity,
  "self-closing-comp": selfClosingComp,
  "style-prop": styleProp,
  "no-array-handlers": noArrayHandlers
  // "validate-jsx-nesting": validateJsxNesting
};
const plugin = { rules };

const recommended = {
  plugins: {
    solid: plugin
  },
  languageOptions: {
    sourceType: "module",
    parserOptions: {
      ecmaFeatures: {
        jsx: true
      }
    }
  },
  rules: {
    // identifier usage is important
    "solid/jsx-no-duplicate-props": 2,
    "solid/jsx-no-undef": 2,
    "solid/jsx-uses-vars": 2,
    "solid/no-unknown-namespaces": 2,
    // security problems
    "solid/no-innerhtml": 2,
    "solid/jsx-no-script-url": 2,
    // reactivity
    "solid/components-return-once": 1,
    "solid/no-destructure": 2,
    "solid/prefer-for": 2,
    "solid/reactivity": 1,
    "solid/event-handlers": 1,
    // these rules are mostly style suggestions
    "solid/imports": 1,
    "solid/style-prop": 1,
    "solid/no-react-deps": 1,
    "solid/no-react-specific-props": 1,
    "solid/self-closing-comp": 1,
    "solid/no-array-handlers": 0,
    // handled by Solid compiler, opt-in style suggestion
    "solid/prefer-show": 0,
    // only necessary for resource-constrained environments
    "solid/no-proxy-apis": 0,
    // deprecated
    "solid/prefer-classlist": 0
  }
};

const typescript = {
  // no files; either apply to all files, or let users spread in this config
  // and specify matching patterns. This is eslint-plugin-react's take.
  plugins: recommended.plugins,
  // no languageOptions; ESLint's default parser can't parse TypeScript,
  // and parsers are configured in languageOptions, so let the user handle
  // this rather than cause potential conflicts
  rules: {
    ...recommended.rules,
    "solid/jsx-no-undef": [2, { typescriptEnabled: true }],
    // namespaces taken care of by TS
    "solid/no-unknown-namespaces": 0
  }
};

const pluginLegacy = {
  rules: plugin.rules,
  configs: {
    recommended: {
      plugins: ["solid"],
      env: {
        browser: true,
        es6: true
      },
      parserOptions: recommended.languageOptions.parserOptions,
      rules: recommended.rules
    },
    typescript: {
      plugins: ["solid"],
      env: {
        browser: true,
        es6: true
      },
      parserOptions: {
        sourceType: "module"
      },
      rules: typescript.rules
    }
  }
};

export { pluginLegacy as default };
