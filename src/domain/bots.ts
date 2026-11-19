/**
 * Search-engine crawlers always get version A (the canonical page) and receive no
 * cookies, so they never pollute the experiment or get "assigned".
 * UA matching is the industry-standard first line; reverse-DNS verification of
 * crawler IPs is noted as a pre-production hardening step in the README.
 */
const SEARCH_BOT_RE =
  /(googlebot|google-inspectiontool|googleother|adsbot-google|mediapartners-google|bingbot|bingpreview|msnbot|adidxbot|slurp|duckduckbot|baiduspider|yandex(bot|images)|sogou|exabot|applebot|seznambot|naver|yeti|petalbot|qwantify|mojeekbot|ia_archiver)/i;

export function isSearchBot(userAgent: string | null | undefined): boolean {
  if (!userAgent) return false;
  return SEARCH_BOT_RE.test(userAgent);
}
