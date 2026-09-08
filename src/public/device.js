// A handful of regexes is enough to bucket a User-Agent for analytics — no
// need for a UA-parsing dependency to answer "mobile or desktop, which browser".
export function classifyDevice(ua) {
  const s = String(ua ?? '');
  const type = /tablet|ipad/i.test(s) ? 'tablet' : /mobi|android|iphone/i.test(s) ? 'mobile' : 'desktop';
  const browser = /edg\//i.test(s) ? 'Edge'
    : /chrome\//i.test(s) ? 'Chrome'
    : /firefox\//i.test(s) ? 'Firefox'
    : /safari\//i.test(s) && /version\//i.test(s) ? 'Safari'
    : 'Other';
  return `${type}-${browser}`;
}
