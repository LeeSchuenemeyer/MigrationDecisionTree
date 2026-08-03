import { describe, expect, it } from 'vitest';
import { checkPG13, isPG13, isSingleEmoji, normalize } from './pg13.js';

const FAMILY = { memberNames: ['Maya', 'Theo', 'Iris', 'Dad', 'Mom'] };

describe('normalization', () => {
  it('collapses leetspeak', () => {
    expect(normalize('sh1t')).toBe('shit');
    expect(normalize('$h!t')).toBe('shit');
    expect(normalize('cr4p')).toBe('crap');
  });

  it('collapses full-width homoglyphs', () => {
    expect(normalize('ｓｈｉｔ')).toBe('shit');
  });

  it('strips zero-width characters', () => {
    // The classic: invisible joiners between every letter.
    expect(normalize('s​h​i​t')).toBe('shit');
    expect(normalize('da‍mn')).toBe('damn');
  });

  it('strips combining accents rather than treating them as new letters', () => {
    expect(normalize('shít')).toBe('shit');
    expect(normalize('DÁMN')).toBe('damn');
  });

  it('collapses separators, so spaced-out spelling is not a bypass', () => {
    expect(normalize('s.h.i.t')).toBe('s h i t');
    expect(normalize('f-u-c-k')).toBe('f u c k');
  });
});

describe('profanity', () => {
  it('rejects the plain forms', () => {
    for (const bad of ['what the hell', 'that was crap', 'damn good work']) {
      expect(isPG13(bad, FAMILY)).toBe(false);
    }
  });

  it('rejects obfuscated forms — this is the whole point of the filter', () => {
    // Each of these renders identically to a plain swear on a wall display.
    for (const bad of ['sh1t', '$h!t', 'ｓｈｉｔ', 's​h​i​t', 'f u c k', 'd.a.m.n']) {
      expect(isPG13(bad, FAMILY)).toBe(false);
    }
  });

  it('does not fire on innocent words that merely contain a banned run', () => {
    // The Scunthorpe problem. A filter that rejects "classic" or "assignment"
    // gets turned off within a week, and then it protects nobody.
    for (const fine of [
      'Classic Tuesday effort',
      'Assignment complete',
      'Grateful for the help',
      'Shell collection tidied',
      'Analysis finished',
    ]) {
      expect(isPG13(fine, FAMILY)).toBe(true);
    }
  });
});

describe('targeting — the rule that actually matters', () => {
  it('allows teasing the task', () => {
    for (const good of [
      'The dishwasher never stood a chance.',
      'Another sock rescued from under the bed.',
      'The recycling bin has been defeated.',
      'Maya cleared the table at record speed.',
      'Theo took out the trash before the timer ran out.',
    ]) {
      expect(isPG13(good, FAMILY)).toBe(true);
    }
  });

  it('rejects a dig at a person, even when every word is individually clean', () => {
    // This is the failure mode the whole feature is guarded against: a line
    // that passes a wordlist and still lands as mockery on a kitchen wall.
    for (const bad of [
      'Maya finally did a chore.',
      'Theo is actually useless at this.',
      'Somehow Iris managed it.',
      'A miracle: Theo cleaned something.',
      'Maya was surprisingly not lazy today.',
    ]) {
      const result = checkPG13(bad, FAMILY);
      expect(result.ok).toBe(false);
      expect(result.code).toBe('targeting');
    }
  });

  it('rejects sibling comparison', () => {
    for (const bad of [
      'Maya did better than Theo today.',
      'Unlike Iris, Theo finished on time.',
      'Theo beat Maya to it.',
    ]) {
      expect(checkPG13(bad, FAMILY).code).toBe('targeting');
    }
  });

  it('only fires when the negative word is near the name', () => {
    // Proximity is the heuristic. A negative word about the *task*, far from
    // anyone's name, is fine — otherwise "the last chore" is unsayable.
    expect(isPG13('Maya cleared the table, and that was the last one standing before dinner finally started', FAMILY)).toBe(true);
  });

  it('does nothing without a member list, since it has no names to match', () => {
    expect(isPG13('Maya finally did a chore.', {})).toBe(true);
  });
});

describe('appearance and eating', () => {
  it('rejects comments on bodies near a name', () => {
    for (const bad of [
      'Maya ate all the snacks again.',
      'Theo has a big belly after that.',
      'Iris looks pretty tired.',
    ]) {
      expect(checkPG13(bad, FAMILY).code).toBe('appearance');
    }
  });

  it('allows the same words when they are about the chore', () => {
    expect(isPG13('The snack cupboard has been restocked.', FAMILY)).toBe(true);
  });
});

describe('structural rules', () => {
  it('rejects links', () => {
    expect(checkPG13('Great work, see example.com', FAMILY).code).toBe('url');
    expect(checkPG13('https://somewhere.test/x', FAMILY).code).toBe('url');
  });

  it('rejects @-mentions', () => {
    expect(checkPG13('Nice one @maya', FAMILY).code).toBe('mention');
  });

  it('rejects sustained shouting but allows a single acronym', () => {
    expect(checkPG13('MAYA DID IT', FAMILY).code).toBe('shouting');
    expect(isPG13('The TV room is tidy', FAMILY)).toBe(true);
  });

  it('rejects over-length and empty', () => {
    expect(checkPG13('x'.repeat(400), FAMILY).code).toBe('too_long');
    expect(checkPG13('   ', FAMILY).code).toBe('empty');
  });

  it('rejects control characters, which have no business on a display', () => {
    expect(checkPG13('nicework', FAMILY).code).toBe('control_chars');
  });
});

describe('household denylist', () => {
  it('rejects family-specific terms a parent added', () => {
    const opts = { ...FAMILY, householdDenylist: ['beanpole', 'the incident'] };
    expect(checkPG13('Nice work, beanpole', opts).code).toBe('household_term');
    // ...and catches the obfuscated form too, since it normalizes first.
    expect(checkPG13('nice work b3anpole', opts).code).toBe('household_term');
  });
});

describe('rejection reasons', () => {
  it('explains the rule rather than echoing the bad word', () => {
    // The reason is fed back to the model on retry; repeating the matched word
    // would just seed it again.
    const result = checkPG13('Maya is lazy', FAMILY);
    expect(result.reason).toBeTruthy();
    expect(result.reason!.toLowerCase()).not.toContain('lazy');
  });

  it('returns no text on rejection, so a caller cannot use it by accident', () => {
    expect(checkPG13('what the hell', FAMILY).text).toBe('');
  });
});

describe('badge icons', () => {
  it('accepts a single emoji', () => {
    for (const e of ['🏆', '🔥', '🧹', '⭐']) expect(isSingleEmoji(e)).toBe(true);
  });

  it('accepts a variation selector', () => {
    expect(isSingleEmoji('⭐️')).toBe(true);
  });

  it('rejects multi-codepoint and ZWJ sequences', () => {
    // These render inconsistently on the cheap tablets this runs on.
    expect(isSingleEmoji('👨‍👩‍👧')).toBe(false);
    expect(isSingleEmoji('🏆🔥')).toBe(false);
  });

  it('rejects text and empty', () => {
    expect(isSingleEmoji('trophy')).toBe(false);
    expect(isSingleEmoji('')).toBe(false);
  });
});
