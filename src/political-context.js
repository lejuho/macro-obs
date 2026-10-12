const { AXES, COUNTRIES } = require('../data/political-contexts');

const DAY = 86_400_000;

function dateOnly(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`잘못된 날짜: ${value}`);
  return d.toISOString().slice(0, 10);
}

function validateProfiles(countries = COUNTRIES) {
  const seen = new Set();
  for (const country of countries) {
    if (!/^[A-Z]{2}$/.test(country.code || '')) throw new Error(`country code 형식: ${country.code}`);
    if (seen.has(country.code)) throw new Error(`country code 중복: ${country.code}`);
    seen.add(country.code);
    let previous = null;
    for (const version of country.versions || []) {
      const from = dateOnly(version.valid_from);
      if (previous && from <= previous) throw new Error(`${country.code} valid_from 순서/중복`);
      previous = from;
      const unknownAxes = Object.keys(version.axes || {}).filter((axis) => !AXES.includes(axis));
      if (unknownAxes.length) throw new Error(`${country.code} 알 수 없는 축: ${unknownAxes.join(',')}`);
    }
  }
  return true;
}

function resolveProfile(countryCode, at = new Date(), countries = COUNTRIES) {
  const day = dateOnly(at);
  const country = countries.find((c) => c.code === countryCode);
  if (!country) return null;
  const version = [...country.versions]
    .reverse()
    .find((v) => v.valid_from <= day && (!v.valid_to || day <= v.valid_to));
  if (!version) return null;
  return {
    country_code: country.code,
    country_name: country.name,
    valid_from: version.valid_from,
    valid_to: version.valid_to,
    axes: version.axes,
    note: version.note || null,
  };
}

function resolveProfiles(countryCodes, at = new Date(), countries = COUNTRIES) {
  return [...new Set(countryCodes || [])]
    .map((code) => resolveProfile(code, at, countries))
    .filter(Boolean);
}

function classifyElectionCycle(profile, election, executiveTerm = {}) {
  if (!profile || !election?.date) return 'unknown';
  if (election.cycle) return election.cycle;
  const rules = profile.axes?.election_cycle || {};
  if (rules.competitive_national_election === 'not_applicable') return 'not_applicable';
  if (election.body === 'midterm') return 'midterm';
  const electionMs = new Date(election.date).getTime();
  const startMs = executiveTerm.start ? new Date(executiveTerm.start).getTime() : NaN;
  const endMs = executiveTerm.end ? new Date(executiveTerm.end).getTime() : NaN;
  if (!Number.isNaN(startMs)) {
    const fromStart = Math.round((electionMs - startMs) / DAY);
    if (Math.abs(fromStart) <= (rules.concurrent_window_days ?? -1)) return 'concurrent';
    if (fromStart > 0 && fromStart <= (rules.honeymoon_window_days ?? -1)) return 'honeymoon';
  }
  if (!Number.isNaN(endMs)) {
    const toEnd = Math.round((endMs - electionMs) / DAY);
    if (toEnd >= 0 && toEnd <= (rules.term_end_window_days ?? -1)) return 'term_end';
  }
  return 'other';
}

function compactForPrompt(profiles) {
  return (profiles || []).map((p) => {
    const a = p.axes || {};
    return {
      country_code: p.country_code,
      country_name: p.country_name,
      effective_from: p.valid_from,
      regime: a.power_structure?.regime,
      legislature: a.power_structure?.legislature,
      election_cycle: a.election_cycle,
      government_status: a.government_status,
      electoral_system: a.electoral_system,
      party_system: a.party_system,
      party_organization: a.party_organization,
      territorial_structure: a.territorial_structure,
      external_constraints: a.external_constraints,
    };
  });
}

validateProfiles();

module.exports = {
  AXES, COUNTRIES, validateProfiles, resolveProfile, resolveProfiles,
  classifyElectionCycle, compactForPrompt,
};
