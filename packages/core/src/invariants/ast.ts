/**
 * The abstract syntax tree.
 *
 * Five node kinds. That is the whole language, and keeping it that small is the
 * point: an invariant is a claim about a ledger, not a program.
 */

/** The aggregate functions. Adding one means adding its empty-case semantics. */
export type FnName = 'sum' | 'count' | 'all' | 'any' | 'unique';

export const FN_NAMES: readonly FnName[] = ['sum', 'count', 'all', 'any', 'unique'];

export type BinaryOp = '<=' | '<' | '>=' | '>' | '==' | '!=' | 'in' | 'and' | 'or';

/** The three roots an expression may name. Nothing else is in scope. */
export type RootName = 'actions' | 'policy' | 'untrusted' | 'subjects';

export const ROOT_NAMES: readonly RootName[] = ['actions', 'policy', 'untrusted', 'subjects'];

export type LiteralValue = number | string | boolean;

export interface LiteralNode {
  readonly type: 'literal';
  readonly value: LiteralValue;
  readonly pos: number;
}

/** `.fieldName` - projects over a collection, indexes into an object. */
export interface FieldStep {
  readonly kind: 'field';
  readonly name: string;
  readonly pos: number;
}

/** `[key=value]` - narrows a collection. Never applies to a scalar. */
export interface FilterStep {
  readonly kind: 'filter';
  readonly key: string;
  readonly value: LiteralValue;
  readonly pos: number;
}

export type PathStep = FieldStep | FilterStep;

export interface PathNode {
  readonly type: 'path';
  readonly root: RootName;
  readonly steps: readonly PathStep[];
  readonly pos: number;
}

export interface CallNode {
  readonly type: 'call';
  readonly fn: FnName;
  readonly arg: Node;
  readonly pos: number;
}

export interface NotNode {
  readonly type: 'not';
  readonly operand: Node;
  readonly pos: number;
}

export interface BinaryNode {
  readonly type: 'binary';
  readonly op: BinaryOp;
  readonly left: Node;
  readonly right: Node;
  readonly pos: number;
}

export type Node = LiteralNode | PathNode | CallNode | NotNode | BinaryNode;

/** Renders an AST back to source. Used in tests to pin down precedence. */
export function unparse(node: Node): string {
  switch (node.type) {
    case 'literal':
      return typeof node.value === 'string' ? JSON.stringify(node.value) : String(node.value);

    case 'path': {
      let out: string = node.root;
      for (const step of node.steps) {
        out +=
          step.kind === 'field'
            ? `.${step.name}`
            : `[${step.key}=${typeof step.value === 'string' ? step.value : String(step.value)}]`;
      }
      return out;
    }

    case 'call':
      return `${node.fn}(${unparse(node.arg)})`;

    case 'not':
      return `(not ${unparse(node.operand)})`;

    case 'binary':
      return `(${unparse(node.left)} ${node.op} ${unparse(node.right)})`;
  }
}
