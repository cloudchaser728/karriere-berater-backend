// animations.js - Slide + Fade für Karriereweg
(function() {
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.1, rootMargin: '0px 0px -40px 0px' });

  function init() {
    const selectors = [
      'h2', '.section-label', '.card', '.step-card',
      '.fach-tag', '.info-box', '.gehalt-row',
      '.filter-btn', '.section p', '.cta-box',
      '.intro h2', '.intro p', '.feature-card',
      '.paket', '.stat-item', '.loesung-step'
    ];
    document.querySelectorAll(selectors.join(', ')).forEach((el, i) => {
      el.classList.add('animate');
      const siblings = Array.from(el.parentElement?.children || []);
      const idx = siblings.indexOf(el);
      if (idx > 0 && idx < 6) el.style.transitionDelay = (idx * 0.1) + 's';
      observer.observe(el);
    });
  }

  document.readyState === 'loading'
    ? document.addEventListener('DOMContentLoaded', init)
    : init();
})();
