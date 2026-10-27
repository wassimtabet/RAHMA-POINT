// Protection anti-clickjacking de remplacement : GitHub Pages ne permet pas d'envoyer X-Frame-Options
// ni `Content-Security-Policy: frame-ancestors`. Ce script est une défense PARTIELLE (best-effort) :
// il n'équivaut pas à l'en-tête HTTP (un attaquant peut l'atténuer avec un iframe « sandbox »).
if (window.top !== window.self) {
  try { window.top.location.href = window.self.location.href; } catch (_) { /* iframe d'une autre origine */ }
  document.documentElement.style.display = 'none';
}
