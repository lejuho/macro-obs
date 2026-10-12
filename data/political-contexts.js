// 국가별 정치 구조 파라미터.
// 변경 원칙: 기존 version을 덮어쓰지 말고 valid_from이 다른 새 version을 추가한다.
// unknown = 아직 확인하지 못함, not_applicable = 해당 체제에는 개념 자체가 적용되지 않음.

const AXES = [
  'power_structure',
  'election_cycle',
  'government_status',
  'electoral_system',
  'party_system',
  'party_organization',
  'territorial_structure',
  'social_cleavages',
  'state_capacity',
  'information_environment',
  'external_constraints',
];

const COUNTRIES = [
  {
    code: 'KR', name: '한국', aliases: ['대한민국', '한국'],
    versions: [{
      valid_from: '2026-01-01', valid_to: null,
      axes: {
        power_structure: { regime: 'presidential', legislature: 'unicameral' },
        election_cycle: { concurrent_window_days: 30, honeymoon_window_days: 365, term_end_window_days: 365 },
        government_status: { executive: 'unknown', legislature: 'unknown', relation: 'unknown' },
        electoral_system: { president: 'single_round_plurality', legislature: 'mixed_member_parallel' },
        party_system: { competition: 'multiparty', effective_parties: 'unknown', alliances: 'unknown' },
        party_organization: { candidate_selection: 'party_specific', discipline: 'strong' },
        territorial_structure: { form: 'unitary', subnational_power: 'limited' },
        social_cleavages: { tracked: ['region', 'generation', 'class', 'gender', 'urban_rural'] },
        state_capacity: { bureaucracy: 'professional', unelected_veto_players: ['constitutional_court'] },
        information_environment: { media_system: 'competitive', platform_role: 'material' },
        external_constraints: { tracked: ['US_alliance', 'North_Korea', 'US_China_competition'] },
      },
      note: '초기 구조 시드. 정부·의회 통제와 연합 상태는 확인 후 새 버전으로 갱신.',
    }],
  },
  {
    code: 'US', name: '미국', aliases: ['미국', '미합중국'],
    versions: [{
      valid_from: '2026-01-01', valid_to: null,
      axes: {
        power_structure: { regime: 'presidential', legislature: 'bicameral', veto_points: ['president', 'house', 'senate', 'courts'] },
        election_cycle: { concurrent_window_days: 30, honeymoon_window_days: 365, term_end_window_days: 365 },
        government_status: { executive: 'unknown', lower_house: 'unknown', upper_house: 'unknown', relation: 'unknown' },
        electoral_system: { president: 'electoral_college', legislature: 'predominantly_single_member' },
        party_system: { competition: 'two_party_dominant', effective_parties: 'unknown', alliances: 'not_applicable' },
        party_organization: { candidate_selection: 'primaries', discipline: 'medium' },
        territorial_structure: { form: 'federal', subnational_power: 'strong' },
        social_cleavages: { tracked: ['region', 'race_ethnicity', 'education', 'class', 'religion', 'urban_rural'] },
        state_capacity: { bureaucracy: 'professional', unelected_veto_players: ['federal_courts'] },
        information_environment: { media_system: 'competitive_fragmented', platform_role: 'material' },
        external_constraints: { tracked: ['alliances', 'Congress_foreign_policy', 'global_dollar_system'] },
      },
      note: '초기 구조 시드. 선거 결과에 따른 분점 여부는 새 버전으로 갱신.',
    }],
  },
  {
    code: 'TW', name: '대만', aliases: ['대만', '타이완'],
    versions: [{
      valid_from: '2026-01-01', valid_to: null,
      axes: {
        power_structure: { regime: 'semi_presidential', legislature: 'unicameral' },
        election_cycle: { concurrent_window_days: 30, honeymoon_window_days: 365, term_end_window_days: 365 },
        government_status: { president: 'unknown', cabinet: 'unknown', legislature: 'unknown', cohabitation: 'unknown' },
        electoral_system: { president: 'single_round_plurality', legislature: 'mixed_member_majoritarian' },
        party_system: { competition: 'multiparty_two_bloc_tendency', effective_parties: 'unknown', alliances: 'unknown' },
        party_organization: { candidate_selection: 'party_specific', discipline: 'strong' },
        territorial_structure: { form: 'unitary', subnational_power: 'material' },
        social_cleavages: { tracked: ['national_identity', 'generation', 'region', 'cross_strait_policy'] },
        state_capacity: { bureaucracy: 'professional', unelected_veto_players: ['constitutional_court'] },
        information_environment: { media_system: 'competitive', platform_role: 'material' },
        external_constraints: { tracked: ['China', 'US_security_support', 'cross_strait_trade'] },
      },
      note: '초기 구조 시드. 총통·입법원 관계 변화는 새 버전으로 갱신.',
    }],
  },
  {
    code: 'CN', name: '중국', aliases: ['중국', '중화인민공화국'],
    versions: [{
      valid_from: '2026-01-01', valid_to: null,
      axes: {
        power_structure: { regime: 'one_party_party_state', legislature: 'noncompetitive_national_legislature' },
        election_cycle: { competitive_national_election: 'not_applicable', selectorate_cycle: 'party_congress' },
        government_status: { unified_divided: 'not_applicable', elite_alignment: 'unknown' },
        electoral_system: { national_competitive_election: 'not_applicable' },
        party_system: { competition: 'one_party_dominant', effective_parties: 'not_applicable', alliances: 'not_applicable' },
        party_organization: { candidate_selection: 'party_selectorate', discipline: 'very_strong' },
        territorial_structure: { form: 'unitary', subnational_power: 'administratively_material_politically_subordinate' },
        social_cleavages: { tracked: ['region', 'urban_rural', 'class', 'center_local', 'ethnicity'] },
        state_capacity: { bureaucracy: 'party_state', unelected_veto_players: ['party_leadership', 'security_organs'] },
        information_environment: { media_system: 'state_party_controlled', platform_role: 'controlled_material' },
        external_constraints: { tracked: ['US_China_competition', 'trade_dependence', 'sanctions_export_controls'] },
      },
      note: '경쟁선거형 분류 대신 당대회·엘리트 연합·후계 구도를 사용.',
    }],
  },
];

// 해도 시나리오 연관국 — 경쟁선거 개념이 맞지 않는 체제는 not_applicable로 명시한다.
COUNTRIES.push(
  {
    code: 'JP', name: '일본', aliases: ['일본'], versions: [{ valid_from: '2026-01-01', valid_to: null, axes: {
      power_structure: { regime: 'parliamentary_constitutional_monarchy', legislature: 'bicameral' },
      election_cycle: { executive_selection: 'parliamentary', early_dissolution: true },
      government_status: { cabinet: 'unknown', lower_house: 'unknown', upper_house: 'unknown', coalition: 'unknown' },
      electoral_system: { lower_house: 'mixed_member_majoritarian', upper_house: 'mixed' },
      party_system: { competition: 'multiparty', effective_parties: 'unknown', alliances: 'unknown' },
      party_organization: { candidate_selection: 'party_specific', discipline: 'strong' },
      territorial_structure: { form: 'unitary', subnational_power: 'material' },
      external_constraints: { tracked: ['US_alliance', 'China', 'energy_imports'] },
    }, note: '초기 구조 시드. 내각·연정 상태는 새 version으로 관리.' }],
  },
  {
    code: 'IR', name: '이란', aliases: ['이란'], versions: [{ valid_from: '2026-01-01', valid_to: null, axes: {
      power_structure: { regime: 'theocratic_presidential_republic', legislature: 'unicameral', veto_points: ['supreme_leader', 'guardian_council'] },
      election_cycle: { competitive_but_constrained: true },
      government_status: { elected_executive: 'unknown', elite_alignment: 'unknown' },
      electoral_system: { president: 'two_round', candidate_screening: 'guardian_council' },
      party_system: { competition: 'factional_constrained', effective_parties: 'unknown' },
      party_organization: { organization: 'faction_networks', discipline: 'variable' },
      territorial_structure: { form: 'unitary', subnational_power: 'limited' },
      external_constraints: { tracked: ['sanctions', 'regional_security', 'oil_exports'] },
    }, note: '선출기관과 비선출 거부권자를 함께 추적.' }],
  },
  {
    code: 'SA', name: '사우디아라비아', aliases: ['사우디', '사우디아라비아'], versions: [{ valid_from: '2026-01-01', valid_to: null, axes: {
      power_structure: { regime: 'absolute_monarchy', legislature: 'consultative' },
      election_cycle: { competitive_national_election: 'not_applicable', succession_cycle: 'royal' },
      government_status: { royal_alignment: 'unknown' },
      electoral_system: { national_competitive_election: 'not_applicable' },
      party_system: { competition: 'not_applicable', effective_parties: 'not_applicable' },
      party_organization: { organization: 'not_applicable' },
      territorial_structure: { form: 'unitary', subnational_power: 'appointed' },
      external_constraints: { tracked: ['oil_market', 'US_security', 'regional_security'] },
    }, note: '선거주기 대신 왕실 승계·엘리트 연합을 추적.' }],
  },
  {
    code: 'AE', name: '아랍에미리트', aliases: ['UAE', '아랍에미리트'], versions: [{ valid_from: '2026-01-01', valid_to: null, axes: {
      power_structure: { regime: 'federal_monarchy', legislature: 'consultative' },
      election_cycle: { competitive_national_election: 'not_applicable', ruler_selection: 'federal_supreme_council' },
      government_status: { emirate_alignment: 'unknown' },
      electoral_system: { national_competitive_election: 'not_applicable' },
      party_system: { competition: 'not_applicable', effective_parties: 'not_applicable' },
      party_organization: { organization: 'not_applicable' },
      territorial_structure: { form: 'federal', subnational_power: 'very_strong' },
      external_constraints: { tracked: ['oil_market', 'regional_security', 'trade_hub'] },
    }, note: '정당체계보다 토후국 간 연합과 연방 최고위원회를 추적.' }],
  },
  {
    code: 'EG', name: '이집트', aliases: ['이집트'], versions: [{ valid_from: '2026-01-01', valid_to: null, axes: {
      power_structure: { regime: 'presidential_republic', legislature: 'bicameral', unelected_veto_players: ['military'] },
      election_cycle: { competitive_but_constrained: true },
      government_status: { executive: 'unknown', legislature: 'unknown' },
      electoral_system: { president: 'two_round', legislature: 'mixed' },
      party_system: { competition: 'dominant_party_constrained', effective_parties: 'unknown' },
      party_organization: { discipline: 'variable' },
      territorial_structure: { form: 'unitary', subnational_power: 'limited' },
      external_constraints: { tracked: ['Suez_Canal', 'Gulf_financing', 'IMF'] },
    }, note: '군부·행정부와 수에즈 운용 역량을 함께 추적.' }],
  },
  {
    code: 'YE', name: '예멘', aliases: ['예멘'], versions: [{ valid_from: '2026-01-01', valid_to: null, axes: {
      power_structure: { regime: 'fragmented_conflict_governance', legislature: 'not_effective_nationally' },
      election_cycle: { competitive_national_election: 'suspended' },
      government_status: { territorial_control: 'fragmented', authority_alignment: 'unknown' },
      electoral_system: { current_operation: 'suspended' },
      party_system: { competition: 'conflict_fragmented', effective_parties: 'unknown' },
      party_organization: { organization: 'party_militia_networks' },
      territorial_structure: { form: 'fragmented', subnational_power: 'de_facto' },
      external_constraints: { tracked: ['regional_intervention', 'Red_Sea_shipping', 'humanitarian_aid'] },
    }, note: '형식 제도보다 실효 지배·외부 후원·무장조직 통제를 추적.' }],
  },
  {
    code: 'EU', name: '유럽연합', aliases: ['EU', '유럽연합'], versions: [{ valid_from: '2026-01-01', valid_to: null, axes: {
      power_structure: { regime: 'supranational_union', legislature: 'parliament_and_council', executive: 'commission' },
      election_cycle: { parliament_cycle: 'five_year', member_state_cycles: 'asynchronous' },
      government_status: { commission: 'unknown', council_coalition: 'issue_specific' },
      electoral_system: { parliament: 'proportional_member_state_specific' },
      party_system: { competition: 'transnational_party_groups', effective_parties: 'unknown' },
      party_organization: { organization: 'national_parties_plus_EU_groups' },
      territorial_structure: { form: 'multilevel_supranational', member_state_power: 'strong' },
      external_constraints: { tracked: ['member_state_vetoes', 'energy_security', 'NATO', 'fiscal_rules'] },
    }, note: '국가 프로필이 아니라 초국가 다층 거버넌스 adapter.' }],
  },
);

module.exports = { AXES, COUNTRIES };
