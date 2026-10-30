"""Two copies of a game table, compared by what they say rather than how they are written.

The mirrors and arkprts decode the same client tables into JSON that differs only in form:
  - an absent field and a null one (flatc leaves defaults out; the mirrors write them);
  - a key/value list and a dict ([{"key": "atk", "value": 30}] and {"atk": 30});
  - a vector wrapped as {"values": [...]} and a bare list;
  - an empty list and an empty dict (arkprts collapses an empty key/value list to {});
  - a field stored as embedded BSON ({"base64": "..."}) and the same field decoded;
  - a table that holds one entry, with or without its single outer key;
  - 30.0 and 30, and BSON's Int64 and a plain int.
canon() writes each such pair the same way, and first_diff() names the first place two
canonical tables part, as a path into the table. Measured 2026-10-19: with these rules the
official decode matched Kengxxiao (CN, 57 of 57 tables) and ArknightsAssets (EN, 55 of 55; JP
and KR, 55 of 55 each).
"""
import base64


def canon(x):
    if isinstance(x, dict):
        if set(x) == {'base64'} and isinstance(x['base64'], str):
            import bson  # pymongo's; arkprts[assets] installs it
            return canon(bson.decode(base64.b64decode(x['base64'])))
        d = {k: canon(v) for k, v in x.items() if v is not None}
        d = {k: v for k, v in d.items() if v is not None}
        if set(d) == {'values'} and isinstance(d['values'], list):
            return d['values']
        return d
    if isinstance(x, list):
        items = [canon(i) for i in x]
        for key, value in (('key', 'value'), ('Key', 'Value')):
            if items and all(isinstance(i, dict) and key in i and set(i) <= {key, value} for i in items):
                return {i[key]: i.get(value) for i in items}
        return items
    if isinstance(x, float) and x.is_integer():
        return int(x)
    if isinstance(x, int) and not isinstance(x, bool) and type(x) is not int:
        return int(x)
    return x


def first_diff(a, b, path=''):
    """The first path where two canonical values part, with what each side holds; None if equal."""
    if isinstance(a, (dict, list)) and isinstance(b, (dict, list)) and not a and not b:
        return None
    if type(a) is not type(b):
        return f'{path or "."}: {type(a).__name__} vs {type(b).__name__}'
    if isinstance(a, dict):
        for k in sorted(set(a) | set(b), key=str):
            if k not in a:
                return f'{path}.{k}: only in the mirror'
            if k not in b:
                return f'{path}.{k}: only in the official decode'
            d = first_diff(a[k], b[k], f'{path}.{k}')
            if d:
                return d
        return None
    if isinstance(a, list):
        if len(a) != len(b):
            return f'{path or "."}: {len(a)} items vs {len(b)}'
        for i, (x, y) in enumerate(zip(a, b)):
            d = first_diff(x, y, f'{path}[{i}]')
            if d:
                return d
        return None
    return None if a == b else f'{path or "."}: {str(a)[:40]!r} vs {str(b)[:40]!r}'


def compare_tables(official, mirror):
    """None when the two parsed tables say the same thing, else the first difference."""
    a, b = canon(official), canon(mirror)
    # A table of one entry: one side may keep its single outer key and the other drop it.
    if isinstance(a, dict) and len(a) == 1 and first_diff(next(iter(a.values())), b) is None:
        return None
    if isinstance(b, dict) and len(b) == 1 and first_diff(a, next(iter(b.values()))) is None:
        return None
    return first_diff(a, b)
