"""What a control's baseline run actually said.

Shared by the two stage3 control tables because they had the same hole, and a
copy is a thing that can disagree with its original.

The hole: both counted lines beginning with `ok`. TAP writes a skipped case as
`ok 3 - name # SKIP`, so disabling a case left the pinned denominator unchanged
and every mutant still reported killed — the count certified execution that had
not happened. Both reviewers of round 4 found it independently, one of them by
skipping the very guarantee that round's commit had added.

So the reading is the reporter's own summary plus the roster of case names that
actually ran, and a baseline is accepted only when those agree with what the
control expects to exist.
"""
import re


FIELDS = ('tests', 'pass', 'fail', 'skipped', 'todo', 'cancelled')


def read_baseline(out, roster):
    """`(ok, reading, why)` for one TAP run against an expected case roster.

    Every summary field is read EVERY time it appears, and a field appearing
    twice with different values is a refusal rather than a first-match win. A
    review wrote an earlier, all-passing summary ahead of the reporter's real one
    and the first-match reader took it: `7 of 7`, while the reporter below said
    one case had been skipped. Whatever produced two summaries, a reading that
    picks one of them is choosing which to believe, and it has no grounds to.
    """
    def totals(field):
        return [int(found) for found in re.findall(rf'^# {field} (\d+)$', out, re.M)]

    named = re.findall(r'^ok \d+ - (.+)$', out, re.M)
    # A directive is what separates "passed" from "was not run at all".
    ran = [name for name in named if not re.search(r'#\s*(SKIP|TODO)\b', name, re.I)]
    seen = {field: totals(field) for field in FIELDS}
    reading = {field: (values[0] if values else None) for field, values in seen.items()}
    reading['ran'] = ran

    reasons = []
    for field, values in seen.items():
        if len(set(values)) > 1:
            reasons.append(f'the run reported {field} {values} — two summaries disagree')
        elif not values:
            reasons.append(f'no {field} line in the reporter output')
    duplicates = sorted({name for name in ran if ran.count(name) > 1})
    if duplicates:
        reasons.append(f'reported more than once: {duplicates}')
    if reading['tests'] != len(roster) or reading['pass'] != len(roster):
        reasons.append(f'expected {len(roster)} cases run and passed, read '
                       f'tests={reading["tests"]} pass={reading["pass"]}')
    for field in ('fail', 'skipped', 'todo', 'cancelled'):
        if reading[field]:
            reasons.append(f'{reading[field]} {field}')
    if len(ran) != reading['tests']:
        reasons.append(f'{len(ran)} cases named as run, summary says {reading["tests"]}')
    missing = [name for name in roster if name not in ran]
    extra = [name for name in ran if name not in roster]
    if missing:
        reasons.append(f'never ran: {missing}')
    if extra:
        reasons.append(f'ran but not on the roster: {extra}')
    return (not reasons), reading, '; '.join(reasons)
