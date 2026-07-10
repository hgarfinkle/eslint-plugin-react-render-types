import type { TSESLint, TSESTree } from "@typescript-eslint/utils";
import { getJSXElementName } from "./component-utils.js";

export type JSXExpressionResolver = (
  expr: TSESTree.Expression
) => TSESTree.Expression | null | undefined;

type SourceCodeWithScopes = {
  getScope(node: TSESTree.Node): TSESLint.Scope.Scope;
};

export function createConstArrayExpressionResolver(
  sourceCode: SourceCodeWithScopes
): JSXExpressionResolver {
  return (expr) => {
    if (expr.type === "ArrayExpression") {
      return expr;
    }

    if (expr.type !== "Identifier") {
      return null;
    }

    const variable = findVariable(sourceCode.getScope(expr), expr.name);
    const definition = variable?.defs[0];
    if (
      definition?.type !== "Variable" ||
      definition.parent.kind !== "const" ||
      definition.node.init?.type !== "ArrayExpression"
    ) {
      return null;
    }

    return definition.node.init;
  };
}

function findVariable(
  scope: TSESLint.Scope.Scope,
  name: string
): TSESLint.Scope.Variable | undefined {
  let currentScope: TSESLint.Scope.Scope | null = scope;
  while (currentScope) {
    const variable = currentScope.set.get(name);
    if (variable) {
      return variable;
    }
    currentScope = currentScope.upper;
  }

  return undefined;
}

/**
 * Recursively extract component names from a JSX expression.
 * Handles:
 * - Direct JSX elements: <Header />
 * - JSX fragments: <></>
 * - Null/undefined literals
 * - Conditional expressions: cond ? <A /> : <B />
 * - Logical expressions: cond && <A />, a || <B />
 * - Array expressions: [<A />, <B />]
 * - .map()/.flatMap() callbacks: items.map(i => <A />)
 */
export function extractJSXFromExpression(
  expr: TSESTree.Expression | TSESTree.JSXEmptyExpression,
  maxDepth: number = 10,
  resolveExpression?: JSXExpressionResolver
): string[] {
  if (maxDepth <= 0) return [];

  switch (expr.type) {
    case "JSXElement": {
      const name = getJSXElementName(expr);
      return name ? [name] : [];
    }

    case "JSXFragment": {
      // Extract from fragment children (expression containers, JSX elements)
      const fragmentResults: string[] = [];
      for (const child of expr.children) {
        if (child.type === "JSXElement") {
          const name = getJSXElementName(child);
          if (name) fragmentResults.push(name);
        } else if (
          child.type === "JSXExpressionContainer" &&
          child.expression.type !== "JSXEmptyExpression"
        ) {
          fragmentResults.push(
            ...extractJSXFromExpression(
              child.expression,
              maxDepth - 1,
              resolveExpression
            )
          );
        }
      }
      // If we extracted children, return them; otherwise return Fragment itself
      return fragmentResults.length > 0 ? fragmentResults : ["Fragment"];
    }

    case "Literal":
      if (expr.value === null) return ["null"];
      if (expr.value === false) return ["false"];
      return [];

    case "Identifier":
      if (expr.name === "undefined") return ["undefined"];
      if (resolveExpression) {
        const resolvedExpr = resolveExpression(expr);
        if (resolvedExpr) {
          return extractJSXFromExpression(
            resolvedExpr,
            maxDepth - 1,
            resolveExpression
          );
        }
      }
      return [];

    case "ConditionalExpression":
      return [
        ...extractJSXFromExpression(
          expr.consequent,
          maxDepth - 1,
          resolveExpression
        ),
        ...extractJSXFromExpression(
          expr.alternate,
          maxDepth - 1,
          resolveExpression
        ),
      ];

    case "LogicalExpression":
      if (expr.operator === "&&") {
        // For &&, the result is either falsy (left) or right
        return extractJSXFromExpression(
          expr.right,
          maxDepth - 1,
          resolveExpression
        );
      }
      // || and ?? — either side could be the result
      return [
        ...extractJSXFromExpression(
          expr.left,
          maxDepth - 1,
          resolveExpression
        ),
        ...extractJSXFromExpression(
          expr.right,
          maxDepth - 1,
          resolveExpression
        ),
      ];

    case "ArrayExpression": {
      return expr.elements.flatMap((element) => {
        if (!element) return [];
        if (element.type !== "SpreadElement") {
          return extractJSXFromExpression(
            element,
            maxDepth - 1,
            resolveExpression
          );
        }

        const resolvedArgument = resolveExpression?.(element.argument);
        return extractJSXFromExpression(
          resolvedArgument ?? element.argument,
          maxDepth - 1,
          resolveExpression
        );
      });
    }

    case "CallExpression":
      return extractJSXFromCallExpression(
        expr,
        maxDepth - 1,
        resolveExpression
      );

    default:
      return [];
  }
}

/**
 * Extract JSX from .map() and .flatMap() callback arguments.
 */
function extractJSXFromCallExpression(
  expr: TSESTree.CallExpression,
  maxDepth: number,
  resolveExpression?: JSXExpressionResolver
): string[] {
  if (expr.callee.type !== "MemberExpression") return [];
  if (expr.callee.property.type !== "Identifier") return [];

  const method = expr.callee.property.name;
  if (method !== "map" && method !== "flatMap") return [];

  const callback = expr.arguments[0];
  if (!callback) return [];

  if (callback.type === "ArrowFunctionExpression") {
    if (callback.body.type !== "BlockStatement") {
      // Expression body: items.map(i => <X />)
      return extractJSXFromExpression(callback.body, maxDepth, resolveExpression);
    }
    // Block body: items.map(i => { return <X />; })
    return extractJSXFromBlock(callback.body, maxDepth, resolveExpression);
  }

  if (callback.type === "FunctionExpression") {
    return extractJSXFromBlock(callback.body, maxDepth, resolveExpression);
  }

  return [];
}

/**
 * Extract JSX from return statements in a block body.
 * Does not recurse into nested functions.
 */
function extractJSXFromBlock(
  block: TSESTree.BlockStatement,
  maxDepth: number,
  resolveExpression?: JSXExpressionResolver
): string[] {
  const results: string[] = [];

  for (const stmt of block.body) {
    if (stmt.type === "ReturnStatement" && stmt.argument) {
      results.push(
        ...extractJSXFromExpression(
          stmt.argument,
          maxDepth,
          resolveExpression
        )
      );
    }
  }

  return results;
}

/**
 * Extract JSX component names from a JSX attribute value.
 * Handles:
 * - JSX elements: prop={<Header />}
 * - Expression containers with JSX: prop={condition ? <A /> : <B />}
 * - Transparent wrappers in attribute values
 */
function extractJSXFromAttribute(
  attr: TSESTree.JSXAttribute,
  transparentComponents: Map<string, Set<string>>,
  visited: Set<string>,
  maxDepth: number,
  resolveExpression?: JSXExpressionResolver
): string[] {
  if (!attr.value) return [];

  if (attr.value.type === "JSXExpressionContainer") {
    const expr = attr.value.expression;
    if (expr.type === "JSXElement") {
      return extractFromJSXElement(
        expr,
        transparentComponents,
        visited,
        maxDepth,
        resolveExpression
      );
    }
    if (expr.type !== "JSXEmptyExpression") {
      return extractJSXFromExpression(expr, maxDepth, resolveExpression);
    }
  } else if (attr.value.type === "JSXElement") {
    return extractFromJSXElement(
      attr.value,
      transparentComponents,
      visited,
      maxDepth,
      resolveExpression
    );
  }

  return [];
}

/**
 * Extract component names from a JSX element, looking through transparent
 * wrappers if applicable. If the element is transparent, extracts from
 * whichever props are configured for that component.
 */
function extractFromJSXElement(
  jsxElement: TSESTree.JSXElement,
  transparentComponents: Map<string, Set<string>>,
  visited: Set<string>,
  maxDepth: number,
  resolveExpression?: JSXExpressionResolver
): string[] {
  const name = getJSXElementName(jsxElement);
  if (!name) return [];

  const propNames = transparentComponents.get(name);
  if (!propNames) {
    // Not transparent — return the element name itself
    return [name];
  }

  // Transparent — extract from configured props
  return extractFromTransparentElement(
    jsxElement,
    propNames,
    transparentComponents,
    visited,
    maxDepth,
    resolveExpression
  );
}

/**
 * Extract component names from a transparent element's configured props.
 * For "children", extracts from the element's JSX children.
 * For other prop names, extracts from the matching JSX attribute values.
 */
function extractFromTransparentElement(
  jsxElement: TSESTree.JSXElement,
  propNames: Set<string>,
  transparentComponents: Map<string, Set<string>>,
  visited: Set<string>,
  maxDepth: number,
  resolveExpression?: JSXExpressionResolver
): string[] {
  if (maxDepth <= 0) return [];

  const elementName = getJSXElementName(jsxElement);
  if (elementName) {
    if (visited.has(elementName)) return [];
    visited.add(elementName);
  }

  const results: string[] = [];

  // Extract from children if "children" is in propNames
  if (propNames.has("children")) {
    extractFromChildren(
      jsxElement.children,
      transparentComponents,
      visited,
      maxDepth,
      results,
      resolveExpression
    );
  }

  // Extract from named prop attributes
  for (const attr of jsxElement.openingElement.attributes) {
    if (attr.type !== "JSXAttribute" || attr.name.type !== "JSXIdentifier") {
      continue;
    }
    const attrName = attr.name.name;
    if (attrName === "children" || !propNames.has(attrName)) {
      continue;
    }
    results.push(
      ...extractJSXFromAttribute(
        attr,
        transparentComponents,
        new Set(visited),
        maxDepth - 1,
        resolveExpression
      )
    );
  }

  return results;
}

/**
 * Extract child element names from a JSX element, looking through
 * transparent wrappers and expression containers.
 *
 * transparentComponents maps component name → set of prop names to extract from.
 */
export function extractChildElementNames(
  jsxElement: TSESTree.JSXElement,
  transparentComponents: Map<string, Set<string>>,
  visited: Set<string> = new Set(),
  maxDepth: number = 10,
  resolveExpression?: JSXExpressionResolver
): string[] {
  if (maxDepth <= 0) return [];

  const elementName = getJSXElementName(jsxElement);

  const propNames = elementName
    ? transparentComponents.get(elementName)
    : undefined;

  // If this element is transparent, extract from its configured props
  if (propNames) {
    return extractFromTransparentElement(
      jsxElement,
      propNames,
      transparentComponents,
      visited,
      maxDepth,
      resolveExpression
    );
  }

  // Non-transparent — extract from children only (backward compat path for direct calls)
  if (elementName) {
    if (visited.has(elementName)) return [];
    visited.add(elementName);
  }

  const results: string[] = [];

  extractFromChildren(
    jsxElement.children,
    transparentComponents,
    visited,
    maxDepth,
    results,
    resolveExpression
  );

  return results;
}

/**
 * Extract component names from JSX children, recursively unwrapping fragments.
 */
function extractFromChildren(
  children: TSESTree.JSXElement["children"],
  transparentComponents: Map<string, Set<string>>,
  visited: Set<string>,
  maxDepth: number,
  results: string[],
  resolveExpression?: JSXExpressionResolver
): void {
  for (const child of children) {
    if (child.type === "JSXFragment") {
      extractFromChildren(
        child.children,
        transparentComponents,
        visited,
        maxDepth,
        results,
        resolveExpression
      );
    } else if (child.type === "JSXElement") {
      results.push(
        ...extractFromJSXElement(
          child,
          transparentComponents,
          new Set(visited),
          maxDepth - 1,
          resolveExpression
        )
      );
    } else if (
      child.type === "JSXExpressionContainer" &&
      child.expression.type !== "JSXEmptyExpression"
    ) {
      results.push(
        ...extractJSXFromExpression(
          child.expression,
          maxDepth - 1,
          resolveExpression
        )
      );
    }
  }
}
