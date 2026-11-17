import { isValidRequestId, resolveRequestId } from './request-id';

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function reqWith(headerValue?: string | string[]) {
  return {
    headers: headerValue === undefined ? {} : { 'x-request-id': headerValue },
  };
}

describe('resolveRequestId — inbound x-request-id trust boundary (plan §4.2, scenario 10)', () => {
  it('trusts a single clean header value verbatim', () => {
    expect(resolveRequestId(reqWith('abc-123'))).toBe('abc-123');
  });

  it('trims surrounding whitespace off an otherwise clean value', () => {
    expect(resolveRequestId(reqWith('  abc-123  '))).toBe('abc-123');
  });

  it.each<[string, string | string[]]>([
    ['duplicated header arriving as an array', ['a', 'b']],
    ['comma-joined duplicate header', 'a,b'],
    ['comma with spaces', 'a, b'],
    ['embedded whitespace', 'has space'],
    ['tab character', 'has\ttab'],
    ['newline (log injection attempt)', 'a\nb'],
    ['over the 128 char cap', 'x'.repeat(129)],
    ['only whitespace', '   '],
    ['empty string', ''],
  ])(
    'replaces an untrustworthy header (%s) with a generated UUID',
    (_label, headerValue) => {
      const requestId = resolveRequestId(reqWith(headerValue));

      expect(requestId).toMatch(UUID_V4);
      expect(requestId).not.toMatch(/[\s,]/);
    },
  );

  it('accepts a value sitting exactly on the 128 char boundary', () => {
    const boundary = 'x'.repeat(128);

    expect(resolveRequestId(reqWith(boundary))).toBe(boundary);
    expect(resolveRequestId(reqWith('x'.repeat(129)))).toMatch(UUID_V4);
  });

  it('generates a UUID when the header is absent entirely', () => {
    expect(resolveRequestId(reqWith())).toMatch(UUID_V4);
  });

  it('returns "" for non-HTTP contexts instead of throwing', () => {
    expect(resolveRequestId(undefined)).toBe('');
    expect(resolveRequestId(null)).toBe('');
    expect(resolveRequestId('not-a-request')).toBe('');
  });

  it('survives a request object with no headers at all', () => {
    expect(resolveRequestId({})).toMatch(UUID_V4);
  });

  it('is idempotent per request object, so access log and business logs agree (scenario 12)', () => {
    const req = reqWith();

    const first = resolveRequestId(req);
    const second = resolveRequestId(req);
    const third = resolveRequestId(req);

    expect(first).toMatch(UUID_V4);
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it('caches per request object, not globally', () => {
    expect(resolveRequestId(reqWith())).not.toBe(resolveRequestId(reqWith()));
  });

  it('keeps the cached value even if headers mutate mid-request', () => {
    const req: any = reqWith();
    const first = resolveRequestId(req);

    req.headers['x-request-id'] = 'late-arrival';

    expect(resolveRequestId(req)).toBe(first);
  });
});

describe('isValidRequestId', () => {
  it('accepts a clean single token', () => {
    expect(isValidRequestId('abc-123')).toBe(true);
  });

  it.each([
    ['array', ['a', 'b']],
    ['number', 42],
    ['undefined', undefined],
    ['null', null],
    ['object', {}],
  ])('rejects a non-string value (%s)', (_label, value) => {
    expect(isValidRequestId(value)).toBe(false);
  });

  it.each([['a,b'], ['a b'], [''], ['   '], ['x'.repeat(129)]])(
    'rejects the dirty string %p',
    (value) => {
      expect(isValidRequestId(value)).toBe(false);
    },
  );
});
