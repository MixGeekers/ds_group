/**
 * Declarative structured-schema oracle (subset of JSON Schema semantics,
 * implemented independently so it does not share a parser with any product
 * validation code).
 *
 * Boundary: decides structural shape only — types, required/additional
 * properties, enums/patterns/formats, ranges and `oneOf` cardinality. It
 * does not decide business semantics, authority, causality or version rules;
 * those have dedicated oracles. `oneOf` requires exactly one branch to pass.
 */
import type { CheckResult, JsonValue, OracleSelfProof, Violation } from './invariant.js';
import { finish, jsonPointerChild, violation } from './invariant.js';
import { deepJsonEqual } from './json.js';

const ORACLE = 'schema';
const VERSION = '1.1.0';
const BOUNDARY =
  '按声明式 schema 判定结构：type/required/additionalProperties/enum/const/pattern/format/范围/uniqueItems/oneOf。' +
  '不判定业务语义、权限、证据独立性或版本单调性。oneOf 要求恰好一个分支通过。';

export type SchemaFormat = 'sha256' | 'sha1' | 'uuid' | 'iso8601' | 'run-id' | 'hex';

export interface ScalarSchema {
  readonly type: 'string' | 'number' | 'boolean' | 'null';
  readonly enum?: readonly JsonValue[];
  readonly const?: JsonValue;
  readonly pattern?: string;
  readonly format?: SchemaFormat;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly integer?: boolean;
  readonly description?: string;
}

export interface ObjectSchema {
  readonly type: 'object';
  readonly properties?: Readonly<Record<string, Schema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | Schema;
  readonly minProperties?: number;
  readonly maxProperties?: number;
  readonly description?: string;
}

export interface ArraySchema {
  readonly type: 'array';
  readonly items?: Schema;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly uniqueItems?: boolean;
  readonly description?: string;
}

export interface OneOfSchema {
  readonly oneOf: readonly Schema[];
  readonly description?: string;
}

export type Schema = ScalarSchema | ObjectSchema | ArraySchema | OneOfSchema;

const FORMATS: Readonly<Record<SchemaFormat, RegExp>> = {
  sha256: /^[0-9a-f]{64}$/,
  sha1: /^[0-9a-f]{40}$/,
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  iso8601: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/,
  'run-id': /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/,
  hex: /^(?:[0-9a-f]{2})*$/,
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

interface WalkContext {
  readonly violations: Violation[];
  checked: number;
  readonly limit: number;
}

function add(context: WalkContext, item: Violation): void {
  if (context.violations.length < context.limit) context.violations.push(item);
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function schemaKind(schema: Schema): string {
  if ('oneOf' in schema) return 'oneOf';
  return schema.type;
}

function checkDefinition(schema: unknown, path: string, context: WalkContext): schema is Schema {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    add(context, violation('schema_definition_invalid', path, 'schema must be an object'));
    return false;
  }
  const candidate = schema as Schema;
  const kind = schemaKind(candidate);
  const allowed = ['string', 'number', 'boolean', 'null', 'object', 'array', 'oneOf'];
  if (!allowed.includes(kind)) {
    add(context, violation('schema_definition_invalid', path, `unknown schema type ${JSON.stringify(kind)}`));
    return false;
  }
  return true;
}

function checkScalar(value: unknown, schema: ScalarSchema, path: string, context: WalkContext): void {
  context.checked++;
  const expected = schema.type;
  const matches = expected === 'null' ? value === null : typeof value === expected;
  if (!matches) {
    add(context, violation('schema_type', path, `expected ${expected}, got ${describeType(value)}`, { expected, actual: describeType(value) }));
    return;
  }
  if (schema.enum !== undefined && !schema.enum.some(item => deepJsonEqual(item, value))) {
    add(context, violation('schema_enum', path, `value is not one of the declared enum members`));
  }
  if (schema.const !== undefined && !deepJsonEqual(schema.const, value)) {
    add(context, violation('schema_const', path, 'value does not equal the declared const'));
  }
  if (expected === 'string' && typeof value === 'string') {
    if (schema.pattern !== undefined) {
      let pattern: RegExp;
      try {
        pattern = new RegExp(schema.pattern);
      } catch {
        add(context, violation('schema_definition_invalid', path, `pattern ${schema.pattern} does not compile`));
        return;
      }
      if (!pattern.test(value)) add(context, violation('schema_pattern', path, `value does not match pattern ${schema.pattern}`));
    }
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      add(context, violation('schema_min_length', path, `length ${value.length} < ${schema.minLength}`));
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      add(context, violation('schema_max_length', path, `length ${value.length} > ${schema.maxLength}`));
    }
    if (schema.format !== undefined) {
      const pattern = FORMATS[schema.format];
      if (pattern === undefined) add(context, violation('schema_definition_invalid', path, `unknown format ${schema.format}`));
      else if (!pattern.test(value)) add(context, violation('schema_format', path, `value is not a valid ${schema.format}`));
      if (schema.format === 'iso8601' && Number.isNaN(Date.parse(value)) && FORMATS.iso8601.test(value)) {
        add(context, violation('schema_format', path, 'iso8601-shaped value is not a real instant'));
      }
    }
  }
  if (expected === 'number' && typeof value === 'number') {
    if (schema.integer && !Number.isInteger(value)) add(context, violation('schema_integer', path, `value ${value} is not an integer`));
    if (schema.minimum !== undefined && value < schema.minimum) add(context, violation('schema_minimum', path, `${value} < ${schema.minimum}`));
    if (schema.maximum !== undefined && value > schema.maximum) add(context, violation('schema_maximum', path, `${value} > ${schema.maximum}`));
  }
}

function checkObject(value: unknown, schema: ObjectSchema, path: string, context: WalkContext): void {
  context.checked++;
  if (!isPlainObject(value)) {
    add(context, violation('schema_type', path, `expected plain object, got ${describeType(value)}`));
    return;
  }
  const record = value as Record<string, unknown>;
  const properties = schema.properties ?? {};
  const keys = Object.keys(record);
  if (schema.minProperties !== undefined && keys.length < schema.minProperties) {
    add(context, violation('schema_min_properties', path, `object has ${keys.length} properties < ${schema.minProperties}`));
  }
  if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) {
    add(context, violation('schema_max_properties', path, `object has ${keys.length} properties > ${schema.maxProperties}`));
  }
  for (const key of schema.required ?? []) {
    if (!Object.hasOwn(record, key)) add(context, violation('schema_required', jsonPointerChild(path, key), 'required property is missing'));
  }
  for (const key of keys) {
    const childPath = jsonPointerChild(path, key);
    const propertySchema = properties[key];
    if (propertySchema !== undefined) {
      if (checkDefinition(propertySchema, childPath, context)) walk(record[key], propertySchema, childPath, context);
      continue;
    }
    if (schema.additionalProperties === false) {
      add(context, violation('schema_additional_property', childPath, 'unexpected property (additionalProperties=false)'));
    } else if (schema.additionalProperties !== undefined && schema.additionalProperties !== true) {
      if (checkDefinition(schema.additionalProperties, childPath, context)) {
        walk(record[key], schema.additionalProperties, childPath, context);
      }
    }
  }
}

function checkArray(value: unknown, schema: ArraySchema, path: string, context: WalkContext): void {
  context.checked++;
  if (!Array.isArray(value)) {
    add(context, violation('schema_type', path, `expected array, got ${describeType(value)}`));
    return;
  }
  if (schema.minItems !== undefined && value.length < schema.minItems) {
    add(context, violation('schema_min_items', path, `array length ${value.length} < ${schema.minItems}`));
  }
  if (schema.maxItems !== undefined && value.length > schema.maxItems) {
    add(context, violation('schema_max_items', path, `array length ${value.length} > ${schema.maxItems}`));
  }
  if (schema.uniqueItems) {
    for (let left = 0; left < value.length; left++) {
      for (let right = left + 1; right < value.length; right++) {
        if (deepJsonEqual(value[left], value[right])) {
          add(context, violation('schema_unique_items', jsonPointerChild(path, right), `duplicate of item at index ${left}`));
        }
      }
    }
  }
  if (schema.items !== undefined && checkDefinition(schema.items, jsonPointerChild(path, 'items'), context)) {
    for (let index = 0; index < value.length; index++) {
      walk(value[index], schema.items, jsonPointerChild(path, index), context);
    }
  }
}

function walk(value: unknown, schema: Schema | undefined, path: string, context: WalkContext): void {
  if (context.violations.length >= context.limit) return;
  if (schema === undefined) return;
  if ('oneOf' in schema) {
    context.checked++;
    if (!Array.isArray(schema.oneOf) || schema.oneOf.length === 0) {
      add(context, violation('schema_definition_invalid', path, 'oneOf must contain at least one branch'));
      return;
    }
    const branchResults = schema.oneOf.map(branch => {
      const scratch: WalkContext = { violations: [], checked: 0, limit: 1000 };
      walk(value, branch, path, scratch);
      return { branch, violations: scratch.violations };
    });
    const passing = branchResults.filter(item => item.violations.length === 0).length;
    if (passing !== 1) {
      add(
        context,
        violation('schema_one_of', path, `oneOf requires exactly one matching branch, got ${passing}`, {
          matchedBranches: passing,
          totalBranches: branchResults.length,
        }),
      );
      // Surface the most informative branch diagnostics (the one with fewest violations).
      const closest = [...branchResults].sort((left, right) => left.violations.length - right.violations.length)[0];
      for (const item of closest.violations.slice(0, 5)) add(context, item);
    }
    return;
  }
  if (schema.type === 'object') checkObject(value, schema, path, context);
  else if (schema.type === 'array') checkArray(value, schema, path, context);
  else checkScalar(value, schema as ScalarSchema, path, context);
}

export function checkSchema(value: unknown, schema: Schema, options: { path?: string; violationLimit?: number } = {}): CheckResult {
  const context: WalkContext = { violations: [], checked: 0, limit: options.violationLimit ?? 200 };
  if (checkDefinition(schema, '$schema', context)) walk(value, schema, options.path ?? '$', context);
  return finish(
    { oracle: ORACLE, version: VERSION, boundary: BOUNDARY, scope: 'schema' },
    context.checked,
    context.violations,
  );
}

/* --------------------------- self-proof --------------------------- */

const digest = 'a'.repeat(64);

const recordSchema: Schema = {
  type: 'object',
  required: ['id', 'digest', 'count', 'tags', 'verdict'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', format: 'run-id', minLength: 3 },
    digest: { type: 'string', format: 'sha256' },
    count: { type: 'number', integer: true, minimum: 0, maximum: 10 },
    tags: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, uniqueItems: true },
    verdict: { type: 'string', enum: ['passed', 'failed', 'unknown'] },
    note: { type: 'string', format: 'uuid' },
  },
};

export const schemaSelfProof: OracleSelfProof = {
  name: ORACLE,
  version: VERSION,
  module: 'tests/harness/schema.ts',
  boundary: BOUNDARY,
  evaluate: input => {
    const { value, schema } = input as { value: unknown; schema: Schema };
    return checkSchema(value, schema);
  },
  samples: [
    {
      label: 'accept-valid-evidence-record',
      input: { value: { id: 'run-1', digest, count: 2, tags: ['oracle'], verdict: 'passed' }, schema: recordSchema },
      expect: 'accept',
      why: '满足 required/type/format/range/uniqueItems 的完整记录',
    },
    {
      label: 'accept-one-of-single-branch',
      input: { value: 'abc', schema: { oneOf: [{ type: 'string', pattern: '^a' }, { type: 'number' }] } },
      expect: 'accept',
      why: 'oneOf 恰有一个分支通过',
    },
    {
      label: 'reject-wrong-type',
      input: { value: { id: 'run-1', digest, count: '2', tags: ['x'], verdict: 'passed' }, schema: recordSchema },
      expect: 'reject',
      expectCodes: ['schema_type'],
      why: 'count 是字符串而非数字',
    },
    {
      label: 'reject-missing-required',
      input: { value: { id: 'run-1', digest, count: 1, tags: ['x'] }, schema: recordSchema },
      expect: 'reject',
      expectCodes: ['schema_required'],
      why: '缺少 verdict 必填字段',
    },
    {
      label: 'reject-additional-property',
      input: { value: { id: 'run-1', digest, count: 1, tags: ['x'], verdict: 'passed', extra: true }, schema: recordSchema },
      expect: 'reject',
      expectCodes: ['schema_additional_property'],
      why: 'additionalProperties=false 时多余字段必须拒绝',
    },
    {
      label: 'reject-enum-member',
      input: { value: { id: 'run-1', digest, count: 1, tags: ['x'], verdict: 'maybe' }, schema: recordSchema },
      expect: 'reject',
      expectCodes: ['schema_enum'],
      why: 'verdict 不在冻结枚举内',
    },
    {
      label: 'reject-pattern',
      input: { value: 'zzz', schema: { type: 'string', pattern: '^a' } },
      expect: 'reject',
      expectCodes: ['schema_pattern'],
      why: '字符串不匹配声明模式',
    },
    {
      label: 'reject-number-range',
      input: { value: 11, schema: { type: 'number', maximum: 10 } },
      expect: 'reject',
      expectCodes: ['schema_maximum'],
      why: '超出声明上界',
    },
    {
      label: 'reject-non-integer',
      input: { value: 1.5, schema: { type: 'number', integer: true } },
      expect: 'reject',
      expectCodes: ['schema_integer'],
      why: 'integer 约束被违反',
    },
    {
      label: 'reject-duplicate-items',
      input: { value: ['x', 'x'], schema: { type: 'array', items: { type: 'string' }, uniqueItems: true } },
      expect: 'reject',
      expectCodes: ['schema_unique_items'],
      why: 'uniqueItems 要求元素两两不同',
    },
    {
      label: 'reject-bad-sha256',
      input: { value: { id: 'run-1', digest: 'A'.repeat(64), count: 1, tags: ['x'], verdict: 'passed' }, schema: recordSchema },
      expect: 'reject',
      expectCodes: ['schema_format'],
      why: '摘要格式要求小写十六进制，大写或错误长度不是冻结摘要',
    },
    {
      label: 'reject-one-of-ambiguous',
      input: { value: 1, schema: { oneOf: [{ type: 'number' }, { type: 'number', minimum: 0 }] } },
      expect: 'reject',
      expectCodes: ['schema_one_of'],
      why: 'oneOf 两个分支同时通过，判定为歧义',
    },
    {
      label: 'reject-one-of-none',
      input: { value: null, schema: { oneOf: [{ type: 'string' }, { type: 'number' }] } },
      expect: 'reject',
      expectCodes: ['schema_one_of'],
      why: '没有分支通过',
    },
    {
      label: 'reject-schema-defect',
      input: { value: 1, schema: { type: 'integer' } as unknown as Schema },
      expect: 'reject',
      expectCodes: ['schema_definition_invalid'],
      why: 'oracle 自身拒绝无效 schema 定义，不猜测作者意图',
    },
  ],
};
