// Scroll reveal (ancien script inline d'index.html, externalisé pour permettre une CSP sans 'unsafe-inline').
const revealObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (!entry.isIntersecting) return;
    entry.target.classList.add('visible');
    entry.target.querySelectorAll('.reveal-child').forEach(child => {
      child.classList.add('visible');
    });
  });
}, { threshold: 0.10 });
document.querySelectorAll('.reveal').forEach(el => revealObserver.observe(el));
