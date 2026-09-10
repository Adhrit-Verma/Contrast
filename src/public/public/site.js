// Behaviour shared by / and /plans. Deliberately small and dependency-free,
// like everything else in this repo.
//
// There is no scroll-reveal here and there will not be one: content that hides
// itself until observed is a bet that JavaScript ran, and it buys nothing a
// reader wanted.

// The sticky bar earns its shadow only once it has actually lifted off the top
// of the document. A shadow on an element flush with the page edge is drawn
// under nothing.
(function () {
  var nav = document.getElementById('nav');
  if (!nav) return;
  var onScroll = function () { nav.classList.toggle('lifted', window.scrollY > 8); };
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();
})();

// Visitor count, set in the colophon rather than shown as a badge with a
// pulsing dot. It is a footnote about this page, so it goes where footnotes go.
(function () {
  var line = document.getElementById('visits-line');
  if (!line) return;
  function poll() {
    fetch('/api/visits').then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      if (!d || d.count < 1) return;
      line.textContent = ' · ' + d.count + (d.count === 1 ? ' visitor' : ' visitors') + ' so far';
    }).catch(function () {});
  }
  poll();
  setInterval(poll, 30000);
})();

/**
 * Drives a looping, demonstrative animation.
 *
 * Every animation on this site runs through here, which is what keeps the
 * rules in one place rather than three: it pauses when the tab is hidden or
 * the element scrolls away (a demo nobody can see is just heat), it exposes a
 * real play/pause control, and under `prefers-reduced-motion` it paints the
 * final frame once and removes the control instead of leaving a dead button.
 *
 * The final frame has to be the complete state, not an arbitrary stopping
 * point — that is what makes the reduced-motion path honest rather than
 * degraded.
 *
 * `reserve` pins the element's height to its tallest frame before the loop
 * starts. Without it a growing demo reflows everything below it on every
 * cycle — measured at 328px to 501px in the hero, which shoved the page around
 * every fourteen seconds. Measuring beats hard-coding a height per breakpoint:
 * the last frame is the tallest by construction, so the browser can just be
 * asked, at whatever width it happens to be.
 *
 * @param {object} o
 * @param {HTMLElement} o.el      element observed for visibility
 * @param {HTMLButtonElement} o.ctl play/pause control
 * @param {Array} o.steps         [holdMs, ...] tuples; shape is up to `paint`
 * @param {(step:any)=>void} o.paint renders one step
 * @param {boolean} [o.reserve]   pin height to the tallest (final) frame
 */
window.loopDemo = function loopDemo(o) {
  if (!o.el || !o.steps.length) return;
  var i = 0, timer = null, playing = true, visible = true;

  function reserve() {
    if (!o.reserve) return;
    o.el.style.minHeight = '';
    o.paint(o.steps[o.steps.length - 1]);
    o.el.style.minHeight = o.el.getBoundingClientRect().height + 'px';
  }
  reserve();
  // A resize changes how the final frame wraps, so the reservation has to be
  // retaken rather than kept from load.
  var rt;
  addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(reserve, 200); }, { passive: true });

  function tick() {
    clearTimeout(timer);
    o.paint(o.steps[i]);
    timer = setTimeout(function () { i = (i + 1) % o.steps.length; tick(); }, o.steps[i][0]);
  }
  function halt() { clearTimeout(timer); timer = null; }
  function resume() { if (playing && visible && !timer) tick(); }

  if (o.ctl) {
    o.ctl.addEventListener('click', function () {
      playing = !playing;
      o.ctl.textContent = playing ? 'Pause' : 'Play';
      o.ctl.setAttribute('aria-pressed', playing ? 'false' : 'true');
      if (playing) resume(); else halt();
    });
  }

  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    o.paint(o.steps[o.steps.length - 1]);
    if (o.ctl) o.ctl.hidden = true;
    return;
  }

  document.addEventListener('visibilitychange', function () {
    visible = !document.hidden;
    if (visible) resume(); else halt();
  });
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (es) {
      es.forEach(function (e) {
        visible = e.isIntersecting && !document.hidden;
        if (visible) resume(); else halt();
      });
    }, { threshold: .15 }).observe(o.el);
  }
  tick();
};
