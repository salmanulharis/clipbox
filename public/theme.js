// Applies the saved theme before the page renders (avoids a flash of the wrong colours).
(function () {
  try {
    var t = localStorage.getItem('clipbox.theme');
    if (t && t !== 'system') document.documentElement.setAttribute('data-theme', t);
  } catch (e) { /* storage unavailable */ }
})();
