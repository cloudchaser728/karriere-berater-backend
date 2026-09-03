// animations.js - Globale Scroll-Animationen für Dein Karriereweg
(function() {
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        observer.unobserve(entry.target);
      }
    });
  }, {
    threshold: 0.12,
    rootMargin: '0px 0px -40px 0px'
  });

  function initAnimations() {
    // Automatisch alle relevanten Elemente animieren
    const selectors = [
      'h1', 'h2', 'h3',
      '.section', '.card', '.step-card', '.package-card', '.paket',
      '.intro', '.faq-item', '.stat-item', '.loesung-step',
      '.problem-text', '.problem-stats', '.kontakt-left',
      '.was-card', '.step', '.tool',
      'p.tagline', '.hero-stat',
      '.unternehmen-sektion', '.cta-box'
    ];

    // Alle explizit markierten Elemente
    document.querySelectorAll('.animate').forEach(el => {
      observer.observe(el);
    });

    // Automatisch alle relevanten Elemente in sections animieren
    document.querySelectorAll(selectors.join(', ')).forEach((el, index) => {
      if (!el.classList.contains('animate')) {
        el.classList.add('animate');
        // Gestaffelte Verzögerung für Geschwister-Elemente
        const siblings = el.parentElement ? Array.from(el.parentElement.children) : [];
        const siblingIndex = siblings.indexOf(el);
        if (siblingIndex > 0 && siblingIndex < 5) {
          el.style.transitionDelay = (siblingIndex * 0.1) + 's';
        }
        observer.observe(el);
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAnimations);
  } else {
    initAnimations();
  }
})();
