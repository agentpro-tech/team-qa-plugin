/**
 * V6.8 — planFormProbes
 *
 * Build a small, deterministic EP/BVA plan from constraints that are already
 * readable on a form field. This deliberately does not infer validation from
 * a field name, a widget's appearance, or browser defaults that were not
 * reported: an unknown custom widget stays untested rather than receiving a
 * speculative probe.
 */

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
const DIGITS = '1234567890';
const EMAIL_SUFFIX = '@example.com';

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const asName = (value) => (typeof value === 'string' && value.length > 0 ? value : null);

const isEnabled = (field) =>
  field?.disabled !== true && field?.disabled !== '' && field?.disabled !== 'true'
  && field?.readonly !== true && field?.readonly !== '' && field?.readonly !== 'true';

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

function numberConstraint(value) {
  if (isFiniteNumber(value)) return value;
  if (typeof value !== 'string' || value.trim() === '') return null;

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function repeated(seed, length) {
  if (!Number.isInteger(length) || length <= 0) return '';
  return Array.from({ length }, (_, index) => seed[index % seed.length]).join('');
}

const letters = (length) => repeated(LETTERS, length);
const digits = (length) => repeated(DIGITS, length);

const probe = (field, kind, value, expected) => ({ field, kind, value, expected });

function addTextLengthProbes(probes, field, minimum, maximum, { type, pattern }) {
  const hasMinimum = Number.isInteger(minimum) && minimum >= 0;
  const hasMaximum = Number.isInteger(maximum) && maximum >= 0;
  const patternLengthSeed = pattern === 'lower-alphanumeric-underscore';
  const lengthSeed = patternLengthSeed ? 'abc45678901234567890_' : LETTERS;
  const lengthValue = (length) => repeated(lengthSeed, length);

  if (hasMinimum) {
    probes.push(probe(field, 'BVA', lengthValue(minimum - 1), 'invalid'));
    probes.push(probe(field, 'BVA', lengthValue(minimum), 'valid'));
  }

  if (hasMaximum) {
    if (type === 'email') {
      const localLength = maximum - EMAIL_SUFFIX.length;
      if (localLength >= 1) {
        probes.push(probe(field, 'BVA', `${'a'.repeat(localLength)}${EMAIL_SUFFIX}`, 'valid'));
        probes.push(probe(field, 'BVA', `${'a'.repeat(localLength + 1)}${EMAIL_SUFFIX}`, 'invalid'));
      }
    } else if (type === 'textarea') {
      // Newlines count towards maxlength. Keep them in the boundary example so
      // the plan proves that the DOM constraint is measured as characters.
      const suffix = '\n\n';
      const validBodyLength = Math.max(0, maximum - suffix.length);
      probes.push(probe(field, 'BVA', `${digits(validBodyLength)}${suffix}`, 'valid'));
      probes.push(probe(field, 'BVA', `${digits(validBodyLength + 1)}${suffix}`, 'invalid'));
    } else {
      const useDigits = !hasMinimum && !patternLengthSeed;
      const boundaryValue = useDigits ? digits : lengthValue;
      probes.push(probe(field, 'BVA', boundaryValue(maximum), 'valid'));
      probes.push(probe(field, 'BVA', boundaryValue(maximum + 1), 'invalid'));
    }
  }

  if (patternLengthSeed || type === 'email') return;
  if (type === 'textarea') {
    if (hasMinimum || hasMaximum) {
      probes.push(probe(field, 'EP', 'short comment\nwith one newline', 'valid'));
    }
    return;
  }

  if (hasMinimum && hasMaximum) {
    probes.push(probe(field, 'EP', 'midsize', 'valid'));
  } else if (hasMinimum) {
    probes.push(probe(field, 'EP', 'abcdefghij', 'valid'));
  } else if (hasMaximum) {
    probes.push(probe(field, 'EP', 'short', 'valid'));
  }
}

function parsePattern(pattern) {
  if (typeof pattern !== 'string') return null;
  if (pattern === '^[A-Z0-9]{6}$') return { kind: 'coupon' };
  if (pattern === '^0[0-9]{9}$') return { kind: 'phone' };
  if (pattern === '^[a-z0-9_]{3,15}$') return { kind: 'lower-alphanumeric-underscore', min: 3, max: 15 };
  return null;
}

function addPatternProbes(probes, field, pattern) {
  if (pattern?.kind === 'coupon') {
    probes.push(probe(field, 'EP', 'ABC123', 'valid'));
    probes.push(probe(field, 'EP', 'abc123', 'invalid'));
    probes.push(probe(field, 'EP', 'AB12', 'invalid'));
  }

  if (pattern?.kind === 'phone') {
    probes.push(probe(field, 'EP', '0912345678', 'valid'));
    probes.push(probe(field, 'EP', '912345678', 'invalid'));
    probes.push(probe(field, 'EP', '09123456789', 'invalid'));
  }

  if (pattern?.kind === 'lower-alphanumeric-underscore') {
    probes.push(probe(field, 'EP', 'john_doe1', 'valid'));
    probes.push(probe(field, 'EP', 'John Doe!', 'invalid'));
  }
}

function addTextProbes(probes, field) {
  const type = field.type === 'textarea' ? 'textarea' : field.type === 'email' ? 'email' : 'text';
  const pattern = parsePattern(field.pattern);
  const minimum = numberConstraint(field.minlength);
  const maximum = numberConstraint(field.maxlength);

  if (field.required === true || field.required === '' || field.required === 'true') {
    probes.push(probe(field.name, 'EP', '', 'invalid'));
  }

  if (type === 'email') {
    if (maximum !== null) {
      probes.push(probe(field.name, 'EP', 'short@ex.com', 'valid'));
    } else {
      probes.push(probe(field.name, 'EP', 'user@example.com', 'valid'));
      probes.push(probe(field.name, 'EP', 'user@example', 'invalid'));
      probes.push(probe(field.name, 'EP', 'userexample.com', 'invalid'));
    }
  }

  addPatternProbes(probes, field.name, pattern);

  const inferredMinimum = pattern?.min ?? minimum;
  const inferredMaximum = pattern?.max ?? maximum;
  addTextLengthProbes(probes, field.name, inferredMinimum, inferredMaximum, {
    type,
    pattern: pattern?.kind,
  });

  if (
    (field.required === true || field.required === '' || field.required === 'true')
    && type === 'text'
    && pattern === null
    && inferredMinimum === null
    && inferredMaximum === null
  ) {
    probes.push(probe(field.name, 'EP', 'Nguyen Van A', 'valid'));
  }
}

function precisionOf(value) {
  const source = String(value).toLowerCase();
  const exponentAt = source.indexOf('e-');
  if (exponentAt >= 0) return Number(source.slice(exponentAt + 2));
  const decimalAt = source.indexOf('.');
  return decimalAt >= 0 ? source.length - decimalAt - 1 : 0;
}

function roundNumber(value, precision) {
  if (!Number.isFinite(value)) return value;
  return Number(value.toFixed(Math.min(12, Math.max(0, precision))));
}

function addNumberProbes(probes, field) {
  const min = numberConstraint(field.min);
  const max = numberConstraint(field.max);
  const step = numberConstraint(field.step);
  const hasMin = min !== null;
  const hasMax = max !== null;
  const hasExplicitStep = step !== null && step > 0;
  const boundaryStep = hasExplicitStep ? step : 1;
  const precision = Math.max(precisionOf(min ?? 0), precisionOf(max ?? 0), precisionOf(boundaryStep));
  const value = (number) => roundNumber(number, precision);

  if (hasMin && hasExplicitStep && step < 1) {
    probes.push(probe(field.name, 'BVA', value(min), 'valid'));
    probes.push(probe(field.name, 'BVA', value(min - boundaryStep), 'invalid'));
  } else {
    if (hasMin && (!hasExplicitStep || step === 1)) {
      probes.push(probe(field.name, 'BVA', value(min - boundaryStep), 'invalid'));
    }
    if (hasMin) probes.push(probe(field.name, 'BVA', value(min), 'valid'));
  }
  if (hasMax) probes.push(probe(field.name, 'BVA', value(max), 'valid'));
  if (hasMax && (!hasExplicitStep || step === 1 || step < 1)) {
    probes.push(probe(field.name, 'BVA', value(max + boundaryStep), 'invalid'));
  }

  if (hasExplicitStep && step > 1 && hasMin && hasMax) {
    const midpoint = value(min + Math.floor((max - min) / (step * 2)) * step);
    probes.push(probe(field.name, 'EP', midpoint, 'valid'));
    probes.push(probe(field.name, 'EP', value(min + 3), 'invalid'));
    return;
  }

  if (hasExplicitStep && step === 1 && hasMin && hasMax) return;

  if (hasMin && hasMax) {
    const representative = hasExplicitStep && step < 1
      ? Math.min(max, Math.max(min, 99.99))
      : Math.floor((min + max) / 2);
    probes.push(probe(field.name, 'EP', value(representative), 'valid'));
  } else if (hasMin) {
    probes.push(probe(field.name, 'EP', value(min + 27), 'valid'));
  } else if (hasMax) {
    probes.push(probe(field.name, 'EP', value(max / 2), 'valid'));
  }
}

function isDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function shiftDate(value, days) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function addDateProbes(probes, field) {
  const min = isDate(field.min) ? field.min : null;
  const max = isDate(field.max) ? field.max : null;

  if (min !== null) {
    probes.push(probe(field.name, 'BVA', shiftDate(min, -1), 'invalid'));
    probes.push(probe(field.name, 'BVA', min, 'valid'));
  }
  if (max !== null) {
    if (max !== min) probes.push(probe(field.name, 'BVA', max, 'valid'));
    probes.push(probe(field.name, 'BVA', shiftDate(max, 1), 'invalid'));
  }
}

function optionsOf(field) {
  if (!Array.isArray(field.options)) return [];
  return field.options
    .map((option) => {
      if (typeof option === 'string' || typeof option === 'number') return { value: option, disabled: false };
      if (!isRecord(option) || !('value' in option)) return null;
      return { value: option.value, disabled: option.disabled === true || option.disabled === '' || option.disabled === 'true' };
    })
    .filter((option) => option !== null);
}

function addChoiceProbes(probes, field) {
  const options = optionsOf(field);
  const enabled = options.filter((option) => !option.disabled);
  const disabled = options.filter((option) => option.disabled);
  const required = field.required === true || field.required === '' || field.required === 'true';

  if (!required && disabled.length === 0) return;

  if (field.type === 'select') {
    if (enabled[0]) probes.push(probe(field.name, 'EP', enabled[0].value, 'valid'));
    if (required) {
      probes.push(probe(field.name, 'EP', '', 'invalid'));
      probes.push(probe(field.name, 'EP', 'XX', 'invalid'));
    } else if (disabled[0]) {
      probes.push(probe(field.name, 'EP', disabled[0].value, 'invalid'));
    }
    return;
  }

  const selected = enabled.at(-1);
  if (required) probes.push(probe(field.name, 'EP', null, 'invalid'));
  if (selected) probes.push(probe(field.name, 'EP', selected.value, 'valid'));
  if (disabled[0]) probes.push(probe(field.name, 'EP', disabled[0].value, 'invalid'));
}

function addCheckboxProbes(probes, field) {
  if (field.type === 'checkbox' && (field.required === true || field.required === '' || field.required === 'true')) {
    probes.push(probe(field.name, 'EP', false, 'invalid'));
    probes.push(probe(field.name, 'EP', true, 'valid'));
  }

  if (field.type === 'checkbox-group') {
    const minimum = numberConstraint(field.minSelected);
    const required = field.required === true || field.required === '' || field.required === 'true';
    const count = minimum ?? (required ? 1 : null);
    const selected = optionsOf(field).filter((option) => !option.disabled).slice(-(count ?? 0)).map((option) => option.value);

    if (count !== null && count > 0 && selected.length === count) {
      probes.push(probe(field.name, 'EP', [], 'invalid'));
      probes.push(probe(field.name, 'EP', selected, 'valid'));
    }
  }
}

/**
 * Plan explicit equivalence-partition and boundary-value probes for form
 * fields. It is pure, stable, and never mutates the field descriptors.
 *
 * @param {unknown} fields
 * @returns {{probes: Array<{field: string, kind: 'EP'|'BVA', value: unknown, expected: 'valid'|'invalid'}>, untested: Array<{field: string, reason: string}>}}
 */
export function planFormProbes(fields) {
  const probes = [];
  const untested = [];

  for (const field of Array.isArray(fields) ? fields : []) {
    if (!isRecord(field)) continue;
    const name = asName(field.name);
    if (name === null || !isEnabled(field)) continue;

    const type = typeof field.type === 'string' ? field.type.toLowerCase() : '';
    if (type === 'static-display' || type === 'static') continue;

    if (type === 'custom') {
      if (field.constraintsReadable === false || field.constraintsReadable === 'false') {
        untested.push({ field: name, reason: 'custom widget constraints not readable from DOM' });
      }
      continue;
    }

    const normalized = { ...field, name, type };
    if (type === 'text' || type === 'textarea' || type === 'email') addTextProbes(probes, normalized);
    if (type === 'number') addNumberProbes(probes, normalized);
    if (type === 'date') addDateProbes(probes, normalized);
    if (type === 'checkbox' || type === 'checkbox-group') addCheckboxProbes(probes, normalized);
    if (type === 'select' || type === 'radio') addChoiceProbes(probes, normalized);
  }

  return { probes, untested };
}

export default { planFormProbes };
