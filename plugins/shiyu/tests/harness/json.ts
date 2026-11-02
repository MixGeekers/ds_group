/**
 * Lossless-JSON and JSON-text oracles.
 *
 * Motivations from the handoff documents:
 * - 02 §4.3: evidence records must survive being serialised without silently
 *   dropping undefined/NaN/-0/class instances.
 * - The real host defect found during H0: an installed plugin tool returned
 *   `invalid output: value is not lossless JSON` because a snapshot contained
 *   explicit `undefined` properties.
 *
 * Boundary: `checkLosslessJson` decides whether JSON.stringify -> JSON.parse
 * preserves the value structure. It does not validate business schema, does
 * not prove cryptographic integrity and (unless `strictUnicode` is on) does
 * not reject lone surrogate escapes. `checkJsonText` decides whether JSON
 * *text* is parseable, has no duplicate object keys and (by default) contains
 * no unpaired surrogate escapes; it does not merge/repair anything.
 */
import type { CheckResult, JsonValue, OracleSelfProof, Violation } from './invariant.js';
import { finish, jsonPointerChild, violation } from './invariant.js';

const ORACLE = 'lossless-json';
const VERSION = '1.1.0';
const BOUNDARY =
  '判定 JSON 往返（stringify→parse 深比较）是否无损：拒绝显式 undefined、NaN/±Infinity、-0、稀疏数组、' +
  '非普通原型对象（Date/Map/class 等）、符号键、访问器属性、循环引用与非 JSON 类型。不证明业务语义、schema 或凭据安全。';

export interface LosslessJsonOptions {
  /** Reject strings containing unpaired surrogate code units. Default false. */
  readonly strictUnicode?: boolean;
  /** Defensive recursion cap. Default 512. */
  readonly maxDepth?: number;
  /** Re-run stringify/parse and deep-compare. Default true. */
  readonly verifyRoundTrip?: boolean;
  /** Stop collecting after this many violations. Default 200. */
  readonly violationLimit?: number;
}

function hasUnpairedSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function isArrayIndexKey(key: string, length: number): boolean {
  if (!/^(?:0|[1-9]\d*)$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index < length;
}

function constructorName(value: object): string {
  const prototype = Object.getPrototypeOf(value) as { constructor?: { name?: string } } | null;
  return prototype?.constructor?.name ?? 'null-prototype';
}

/**
 * Walk a value and collect every way JSON round-tripping would lose it.
 * Deferred verification (stringify/parse/deep compare) only runs when the
 * structural walk found nothing, so a result is never "ok" by accident.
 */
export function checkLosslessJson(value: unknown, options: LosslessJsonOptions = {}): CheckResult {
  const strictUnicode = options.strictUnicode ?? false;
  const maxDepth = options.maxDepth ?? 512;
  const violationLimit = options.violationLimit ?? 200;
  const violations: Violation[] = [];
  const stack = new Set<object>();
  let checked = 0;
  let suppressed = 0;
  const add = (item: Violation): void => {
    if (violations.length >= violationLimit) {
      suppressed++;
      return;
    }
    violations.push(item);
  };

  const visit = (current: unknown, path: string, depth: number): void => {
    checked++;
    if (depth > maxDepth) {
      add(violation('max_depth_exceeded', path, `value nesting deeper than ${maxDepth}`));
      return;
    }
    switch (typeof current) {
      case 'undefined':
        add(violation('undefined_value', path, 'undefined is dropped from objects and becomes null in arrays'));
        return;
      case 'number':
        if (Number.isNaN(current)) add(violation('non_finite_number', path, 'NaN becomes null in JSON'));
        else if (!Number.isFinite(current)) add(violation('non_finite_number', path, `${String(current)} becomes null in JSON`));
        else if (Object.is(current, -0)) add(violation('negative_zero', path, '-0 is serialised as 0 and loses its sign'));
        return;
      case 'bigint':
        add(violation('unsupported_bigint', path, 'BigInt is not representable in JSON text'));
        return;
      case 'function':
        add(violation('unsupported_function', path, 'functions are dropped by JSON.stringify'));
        return;
      case 'symbol':
        add(violation('unsupported_symbol', path, 'symbol values are dropped by JSON.stringify'));
        return;
      case 'string':
        if (strictUnicode && hasUnpairedSurrogate(current)) {
          add(violation('unpaired_surrogate', path, 'string contains an unpaired surrogate code unit'));
        }
        return;
      case 'boolean':
        return;
      case 'object':
        break;
    }
    if (current === null) return;
    const object = current as object;
    if (stack.has(object)) {
      add(violation('cyclic_reference', path, 'value references one of its own ancestors'));
      return;
    }
    stack.add(object);
    try {
      if (Array.isArray(object)) {
        if (Object.getPrototypeOf(object) !== Array.prototype) {
          add(violation('non_plain_object', path, `array subclass or exotic array (${constructorName(object)})`));
        }
        const length = object.length;
        for (let index = 0; index < length; index++) {
          const childPath = jsonPointerChild(path, index);
          const descriptor = Object.getOwnPropertyDescriptor(object, String(index));
          if (descriptor === undefined) {
            add(violation('sparse_array', childPath, 'array hole is serialised as null'));
            continue;
          }
          if (descriptor.get !== undefined) {
            add(violation('accessor_property', childPath, 'accessor is invoked by JSON.stringify'));
            continue;
          }
          visit(descriptor.value, childPath, depth + 1);
        }
        for (const key of Object.keys(object)) {
          if (isArrayIndexKey(key, length)) continue;
          add(violation('array_named_property', jsonPointerChild(path, key), 'non-index properties on arrays are dropped by JSON.stringify'));
        }
        for (const key of Object.getOwnPropertySymbols(object)) {
          add(violation('symbol_key', path, `symbol key ${String(key)} is ignored`));
        }
        return;
      }
      const prototype = Object.getPrototypeOf(object);
      if (prototype !== Object.prototype && prototype !== null) {
        add(violation('non_plain_object', path, `${constructorName(object)} is not a plain object; its serialised shape is not the value itself`));
        return;
      }
      for (const key of Reflect.ownKeys(object)) {
        if (typeof key === 'symbol') {
          add(violation('symbol_key', path, `symbol key ${String(key)} is ignored`));
          continue;
        }
        const childPath = jsonPointerChild(path, key);
        const descriptor = Object.getOwnPropertyDescriptor(object, key)!;
        if (descriptor.get !== undefined) {
          add(violation('accessor_property', childPath, 'accessor is invoked by JSON.stringify'));
          continue;
        }
        if (!descriptor.enumerable) {
          add(violation('non_enumerable_property', childPath, 'non-enumerable property is dropped by JSON.stringify'));
          continue;
        }
        visit(descriptor.value, childPath, depth + 1);
      }
    } finally {
      stack.delete(object);
    }
  };

  visit(value, '$', 0);

  const metrics: Record<string, JsonValue> = { violations: violations.length, suppressed };
  if (violations.length === 0 && (options.verifyRoundTrip ?? true)) {
    let text: string;
    try {
      text = JSON.stringify(value);
    } catch (error) {
      add(violation('stringify_threw', '$', `JSON.stringify threw: ${error instanceof Error ? error.message : String(error)}`));
      return finish({ oracle: ORACLE, version: VERSION, boundary: BOUNDARY, scope: 'value' }, checked, violations, metrics);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      add(violation('roundtrip_parse_failed', '$', `serialised text did not parse: ${error instanceof Error ? error.message : String(error)}`));
      return finish({ oracle: ORACLE, version: VERSION, boundary: BOUNDARY, scope: 'value' }, checked, violations, metrics);
    }
    const mismatches: Violation[] = [];
    collectJsonMismatches(value, parsed, '$', mismatches, 100);
    for (const mismatch of mismatches) add(mismatch);
    metrics.serialisedBytes = Buffer.byteLength(text, 'utf8');
  }
  return finish({ oracle: ORACLE, version: VERSION, boundary: BOUNDARY, scope: 'value' }, checked, violations, metrics);
}

function collectJsonMismatches(expected: unknown, actual: unknown, path: string, out: Violation[], limit: number): void {
  if (out.length >= limit) return;
  if (Object.is(expected, actual)) return;
  if (typeof expected !== typeof actual) {
    out.push(violation('roundtrip_mismatch', path, `round-trip changed type ${typeof expected} -> ${typeof actual}`));
    return;
  }
  if (expected === null || actual === null || typeof expected !== 'object') {
    out.push(violation('roundtrip_mismatch', path, 'round-trip changed a primitive value'));
    return;
  }
  const expectedArray = Array.isArray(expected);
  const actualArray = Array.isArray(actual);
  if (expectedArray !== actualArray) {
    out.push(violation('roundtrip_mismatch', path, 'round-trip changed array/object shape'));
    return;
  }
  if (expectedArray) {
    const left = expected as unknown[];
    const right = actual as unknown[];
    if (left.length !== right.length) {
      out.push(violation('roundtrip_mismatch', path, `round-trip changed length ${left.length} -> ${right.length}`));
      return;
    }
    for (let index = 0; index < left.length; index++) collectJsonMismatches(left[index], right[index], jsonPointerChild(path, index), out, limit);
    return;
  }
  const expectedRecord = expected as Record<string, unknown>;
  const actualRecord = actual as Record<string, unknown>;
  const expectedKeys = Object.keys(expectedRecord).sort();
  const actualKeys = Object.keys(actualRecord).sort();
  if (expectedKeys.join('\u0000') !== actualKeys.join('\u0000')) {
    out.push(violation('roundtrip_mismatch', path, 'round-trip changed the set of object keys'));
    return;
  }
  for (const key of expectedKeys) collectJsonMismatches(expectedRecord[key], actualRecord[key], jsonPointerChild(path, key), out, limit);
}

/** Throwing adapter used by evidence writers before persisting a record. */
export function assertLosslessJson(value: unknown, options: LosslessJsonOptions = {}): void {
  const result = checkLosslessJson(value, options);
  if (!result.ok) {
    const failure = new Error(`value is not lossless JSON: ${result.violations.map(item => `${item.code}@${item.path}`).join(', ')}`);
    Object.assign(failure, { code: 'NOT_LOSSLESS_JSON', result });
    throw failure;
  }
}

export function isLosslessJson(value: unknown, options: LosslessJsonOptions = {}): boolean {
  return checkLosslessJson(value, options).ok;
}

/* ------------------------------------------------------------------ */
/* JSON text checker (parseability, duplicate keys, strict Unicode).   */
/* ------------------------------------------------------------------ */

const TEXT_ORACLE = 'json-text';
const TEXT_VERSION = '1.1.0';
const TEXT_BOUNDARY =
  '判定 JSON 文本可解析、对象键不重复、可选地拒绝孤立代理项转义；重复键按解析器“后者覆盖”视为有损并拒绝。' +
  '不检查业务 schema，不修复文本，不证明内容来源可信。';

export interface JsonTextOptions {
  readonly strictUnicode?: boolean;
  readonly detectDuplicateKeys?: boolean;
  readonly maxBytes?: number;
}

export interface ParsedJsonText {
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: string;
}

export function parseJsonText(text: string): ParsedJsonText {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

interface DuplicateKeyFinding {
  readonly key: string;
  readonly path: string;
  readonly position: number;
}

class DuplicateKeyScanner {
  private index = 0;
  private readonly findings: DuplicateKeyFinding[] = [];

  constructor(private readonly text: string) {}

  scan(): DuplicateKeyFinding[] {
    this.scanValue('$');
    return this.findings;
  }

  private scanValue(path: string): void {
    this.skipWhitespace();
    const char = this.text[this.index];
    if (char === '{') this.scanObject(path);
    else if (char === '[') this.scanArray(path);
    else if (char === '"') this.scanString();
    else this.scanPrimitive();
  }

  private scanObject(path: string): void {
    const start = this.index;
    this.index++; // {
    const keys = new Set<string>();
    this.skipWhitespace();
    if (this.text[this.index] === '}') {
      this.index++;
      return;
    }
    for (;;) {
      this.skipWhitespace();
      const keyStart = this.index;
      const key = this.scanString();
      this.skipWhitespace();
      if (this.text[this.index] !== ':') throw new Error(`expected ':' at ${this.index} (object starting ${start})`);
      this.index++;
      const childPath = jsonPointerChild(path, key);
      if (keys.has(key)) this.findings.push({ key, path: childPath, position: keyStart });
      keys.add(key);
      this.scanValue(childPath);
      this.skipWhitespace();
      const next = this.text[this.index];
      if (next === ',') {
        this.index++;
        continue;
      }
      if (next === '}') {
        this.index++;
        return;
      }
      throw new Error(`expected ',' or '}' at ${this.index}`);
    }
  }

  private scanArray(path: string): void {
    this.index++; // [
    this.skipWhitespace();
    if (this.text[this.index] === ']') {
      this.index++;
      return;
    }
    let item = 0;
    for (;;) {
      this.scanValue(jsonPointerChild(path, item));
      item++;
      this.skipWhitespace();
      const next = this.text[this.index];
      if (next === ',') {
        this.index++;
        continue;
      }
      if (next === ']') {
        this.index++;
        return;
      }
      throw new Error(`expected ',' or ']' at ${this.index}`);
    }
  }

  private scanString(): string {
    if (this.text[this.index] !== '"') throw new Error(`expected string at ${this.index}`);
    const start = this.index;
    this.index++;
    let result = '';
    while (this.index < this.text.length) {
      const char = this.text[this.index];
      if (char === '"') {
        this.index++;
        return result;
      }
      if (char === '\\') {
        const escape = this.text[this.index + 1];
        this.index += 2;
        switch (escape) {
          case '"':
          case '\\':
          case '/':
            result += escape;
            break;
          case 'b':
            result += '\b';
            break;
          case 'f':
            result += '\f';
            break;
          case 'n':
            result += '\n';
            break;
          case 'r':
            result += '\r';
            break;
          case 't':
            result += '\t';
            break;
          case 'u': {
            const hex = this.text.slice(this.index, this.index + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`bad unicode escape at ${this.index - 2}`);
            result += String.fromCharCode(Number.parseInt(hex, 16));
            this.index += 4;
            break;
          }
          default:
            throw new Error(`bad escape at ${this.index - 2}`);
        }
        continue;
      }
      result += char;
      this.index++;
    }
    throw new Error(`unterminated string starting ${start}`);
  }

  private scanPrimitive(): void {
    const start = this.index;
    while (this.index < this.text.length) {
      const char = this.text[this.index];
      if (char === ',' || char === ']' || char === '}' || char === ' ' || char === '\n' || char === '\r' || char === '\t') break;
      this.index++;
    }
    if (this.index === start) throw new Error(`expected value at ${start}`);
  }

  private skipWhitespace(): void {
    while (this.index < this.text.length && /[ \t\n\r]/.test(this.text[this.index])) this.index++;
  }
}

function findUnpairedSurrogates(value: unknown, path: string, out: Violation[], limit: number): void {
  if (out.length >= limit) return;
  if (typeof value === 'string') {
    if (hasUnpairedSurrogate(value)) out.push(violation('unpaired_surrogate', path, 'string contains an unpaired surrogate code unit'));
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) findUnpairedSurrogates(value[index], jsonPointerChild(path, index), out, limit);
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) findUnpairedSurrogates(child, jsonPointerChild(path, key), out, limit);
}

export function checkJsonText(text: unknown, options: JsonTextOptions = {}): CheckResult {
  const strictUnicode = options.strictUnicode ?? true;
  const detectDuplicateKeys = options.detectDuplicateKeys ?? true;
  const violations: Violation[] = [];
  if (typeof text !== 'string') {
    violations.push(violation('not_a_string', '$', `expected JSON text, got ${typeof text}`));
    return finish({ oracle: TEXT_ORACLE, version: TEXT_VERSION, boundary: TEXT_BOUNDARY, scope: 'text' }, 0, violations);
  }
  const bytes = Buffer.byteLength(text, 'utf8');
  if (options.maxBytes !== undefined && bytes > options.maxBytes) {
    violations.push(violation('text_too_large', '$', `${bytes} bytes exceeds limit ${options.maxBytes}`));
    return finish({ oracle: TEXT_ORACLE, version: TEXT_VERSION, boundary: TEXT_BOUNDARY, scope: 'text' }, 1, violations, { bytes });
  }
  const parsed = parseJsonText(text);
  if (!parsed.ok) {
    violations.push(violation('json_parse_error', '$', parsed.error ?? 'invalid JSON'));
    return finish({ oracle: TEXT_ORACLE, version: TEXT_VERSION, boundary: TEXT_BOUNDARY, scope: 'text' }, 1, violations, { bytes });
  }
  let checked = 1;
  if (detectDuplicateKeys) {
    try {
      const duplicates = new DuplicateKeyScanner(text).scan();
      for (const duplicate of duplicates) {
        violations.push(
          violation('duplicate_object_key', duplicate.path, `duplicate object key ${JSON.stringify(duplicate.key)} (last value wins when parsed)`, {
            position: duplicate.position,
          }),
        );
      }
    } catch (error) {
      violations.push(violation('duplicate_key_scan_failed', '$', `scanner could not finish: ${error instanceof Error ? error.message : String(error)}`));
    }
  }
  if (strictUnicode) findUnpairedSurrogates(parsed.value, '$', violations, 100);
  checked += violations.length;
  return finish({ oracle: TEXT_ORACLE, version: TEXT_VERSION, boundary: TEXT_BOUNDARY, scope: 'text' }, checked, violations, {
    bytes,
    duplicateKeysDetected: violations.filter(item => item.code === 'duplicate_object_key').length,
  });
}

/**
 * Deterministic sorted-key serialisation for evidence hashing. Only accepts
 * values that already pass `checkLosslessJson`; otherwise it throws so a
 * lossy value can never silently enter a hash chain.
 */
export function canonicalJsonString(value: unknown): string {
  const check = checkLosslessJson(value, { verifyRoundTrip: true });
  if (!check.ok) {
    const error = new Error(`cannot canonicalise non-lossless JSON: ${check.violations.map(item => `${item.code}@${item.path}`).join(', ')}`);
    Object.assign(error, { code: 'NOT_LOSSLESS_JSON', result: check });
    throw error;
  }
  return canonicalise(value);
}

function canonicalise(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
    case 'number':
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(item => canonicalise(item)).join(',')}]`;
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalise(record[key])}`).join(',')}}`;
    }
    default:
      throw new Error(`unexpected canonical JSON type ${typeof value}`);
  }
}

/** Deep structural equality with Object.is semantics for primitives. */
export function deepJsonEqual(left: unknown, right: unknown): boolean {
  const scratch: Violation[] = [];
  collectJsonMismatches(left, right, '$', scratch, 1);
  return scratch.length === 0;
}

/* ------------------------------------------------------------------ */
/* Self-proofs.                                                        */
/* ------------------------------------------------------------------ */

class SyntheticRecord {
  readonly kind = 'synthetic';
}

const cycle: { self?: unknown } = {};
cycle.self = cycle;

const shared = { id: 'shared' };

export const losslessJsonSelfProof: OracleSelfProof = {
  name: ORACLE,
  version: VERSION,
  module: 'tests/harness/json.ts',
  boundary: BOUNDARY,
  evaluate: input => {
    const { value, options } = input as { value: unknown; options?: LosslessJsonOptions };
    return checkLosslessJson(value, options);
  },
  samples: [
    {
      label: 'accept-nested-unicode',
      input: { value: { a: 1, b: [true, null, '识雨😀'], c: { d: 'x\ny' } } },
      expect: 'accept',
      why: '普通 plain object/array/标量，往返结构不变',
    },
    {
      label: 'accept-empty-structures',
      input: { value: { a: {}, b: [], c: null, d: 0, e: -1.5 } },
      expect: 'accept',
      why: '空容器与普通数字可无损往返',
    },
    {
      label: 'accept-shared-reference-structure',
      input: { value: { left: shared, right: shared } },
      expect: 'accept',
      why: 'JSON 会复制共享引用但结构相等；oracle 不要求保留对象身份',
    },
    {
      label: 'reject-undefined-object-property',
      input: { value: { a: 1, checkedAt: undefined } },
      expect: 'reject',
      expectCodes: ['undefined_value'],
      why: '显式 undefined 属性被 JSON.stringify 丢弃，正是本轮宿主 shiyu_status 缺陷形态',
    },
    {
      label: 'reject-undefined-array-element',
      input: { value: [1, undefined, 3] },
      expect: 'reject',
      expectCodes: ['undefined_value'],
      why: '数组中的 undefined 被序列化为 null',
    },
    {
      label: 'reject-non-finite',
      input: { value: { a: Number.NaN, b: Number.POSITIVE_INFINITY, c: Number.NEGATIVE_INFINITY } },
      expect: 'reject',
      expectCodes: ['non_finite_number', 'non_finite_number', 'non_finite_number'],
      why: 'NaN 与无穷都被序列化为 null',
    },
    {
      label: 'reject-negative-zero',
      input: { value: { delta: -0 } },
      expect: 'reject',
      expectCodes: ['negative_zero'],
      why: '-0 往返后变成 0，符号丢失',
    },
    {
      label: 'reject-sparse-array',
      input: { value: [1, , 3] },
      expect: 'reject',
      expectCodes: ['sparse_array'],
      why: '数组空洞被序列化为 null',
    },
    {
      label: 'reject-date-instance',
      input: { value: { at: new Date('2026-11-02T00:00:00.000Z') } },
      expect: 'reject',
      expectCodes: ['non_plain_object'],
      why: 'Date 通过 toJSON 变成字符串，序列化形状不再是原值',
    },
    {
      label: 'reject-class-instance',
      input: { value: { record: new SyntheticRecord() } },
      expect: 'reject',
      expectCodes: ['non_plain_object'],
      why: '类实例的原型不是 Object.prototype，不能当作普通 JSON 对象',
    },
    {
      label: 'reject-map-and-set',
      input: { value: { m: new Map([['a', 1]]), s: new Set([1]) } },
      expect: 'reject',
      expectCodes: ['non_plain_object', 'non_plain_object'],
      why: 'Map/Set 序列化为 {}，内容丢失',
    },
    {
      label: 'reject-symbol-key',
      input: { value: { [Symbol('hidden')]: 1 } },
      expect: 'reject',
      expectCodes: ['symbol_key'],
      why: 'symbol 键被 JSON.stringify 忽略',
    },
    {
      label: 'reject-function-property',
      input: { value: { fn: () => 1 } },
      expect: 'reject',
      expectCodes: ['unsupported_function'],
      why: '函数属性被丢弃',
    },
    {
      label: 'reject-bigint',
      input: { value: { big: 1n } },
      expect: 'reject',
      expectCodes: ['unsupported_bigint'],
      why: 'BigInt 无法写入 JSON 文本',
    },
    {
      label: 'reject-getter-property',
      input: { value: Object.defineProperty({}, 'computed', { enumerable: true, get: () => 1 }) },
      expect: 'reject',
      expectCodes: ['accessor_property'],
      why: 'getter 会在序列化时被调用，往返无法还原访问器',
    },
    {
      label: 'reject-array-named-property',
      input: { value: Object.assign([1, 2], { extra: 3 }) },
      expect: 'reject',
      expectCodes: ['array_named_property'],
      why: '数组的非索引属性被忽略',
    },
    {
      label: 'reject-cyclic-reference',
      input: { value: cycle },
      expect: 'reject',
      expectCodes: ['cyclic_reference'],
      why: '循环引用会让 JSON.stringify 抛错，未执行往返',
    },
    {
      label: 'reject-non-enumerable-property',
      input: { value: Object.defineProperty({ visible: 1 }, 'hidden', { value: 2, enumerable: false }) },
      expect: 'reject',
      expectCodes: ['non_enumerable_property'],
      why: '不可枚举属性被序列化忽略',
    },
  ],
};

export const jsonTextSelfProof: OracleSelfProof = {
  name: TEXT_ORACLE,
  version: TEXT_VERSION,
  module: 'tests/harness/json.ts',
  boundary: TEXT_BOUNDARY,
  evaluate: input => {
    const { text, options } = input as { text: unknown; options?: JsonTextOptions };
    return checkJsonText(text, options);
  },
  samples: [
    {
      label: 'accept-plain-document',
      input: { text: '{"a":1,"b":[true,null,"x"],"c":{"d":"识雨"}}' },
      expect: 'accept',
      why: '合法 JSON 文档，无重复键、无孤立代理项',
    },
    {
      label: 'accept-escaped-surrogate-pair',
      input: { text: '{"emoji":"\\ud83d\\ude00"}' },
      expect: 'accept',
      why: '成对代理项转义构成合法 Unicode 字符',
    },
    {
      label: 'reject-invalid-json',
      input: { text: '{"a":' },
      expect: 'reject',
      expectCodes: ['json_parse_error'],
      why: '截断文本不可解析',
    },
    {
      label: 'reject-duplicate-object-key',
      input: { text: '{"a":1,"a":2}' },
      expect: 'reject',
      expectCodes: ['duplicate_object_key'],
      why: '重复键解析后后者覆盖，原始信息丢失',
    },
    {
      label: 'reject-nested-duplicate-key',
      input: { text: '{"outer":{"k":1,"k":2}}' },
      expect: 'reject',
      expectCodes: ['duplicate_object_key'],
      why: '嵌套对象中的重复键同样有损',
    },
    {
      label: 'reject-lone-surrogate-escape',
      input: { text: '{"bad":"\\ud800"}' },
      expect: 'reject',
      expectCodes: ['unpaired_surrogate'],
      why: '孤立代理项不是可安全交换的 UTF-8 JSON 文本',
    },
    {
      label: 'reject-text-too-large',
      input: { text: '{"a":1}', options: { maxBytes: 4 } },
      expect: 'reject',
      expectCodes: ['text_too_large'],
      why: '超过调用方冻结的字节上限时必须显式拒绝，不能截断',
    },
    {
      label: 'reject-non-string-input',
      input: { text: 42 },
      expect: 'reject',
      expectCodes: ['not_a_string'],
      why: '文本检查器不能把非文本输入当成合法 JSON',
    },
  ],
};
