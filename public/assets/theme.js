// Light/dark toggle. Loaded in <head> so the theme is applied before first paint.
// Follows the OS setting until the person picks one, then remembers the choice.
(function(){
  var KEY = "n3dcat-theme";
  var root = document.documentElement;
  var mq = window.matchMedia("(prefers-color-scheme: dark)");
  function stored(){ try { return localStorage.getItem(KEY); } catch(e){ return null; } }
  function apply(t){
    root.setAttribute("data-theme", t);
    var btns = document.querySelectorAll("[data-theme-toggle]");
    for (var i = 0; i < btns.length; i++) {
      btns[i].setAttribute("aria-label", t === "dark" ? "Switch to light mode" : "Switch to dark mode");
      btns[i].setAttribute("aria-pressed", t === "dark" ? "true" : "false");
    }
  }
  apply(stored() || (mq.matches ? "dark" : "light"));
  mq.addEventListener && mq.addEventListener("change", function(e){ if (!stored()) apply(e.matches ? "dark" : "light"); });
  document.addEventListener("click", function(e){
    var b = e.target.closest && e.target.closest("[data-theme-toggle]");
    if (!b) return;
    var next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
    try { localStorage.setItem(KEY, next); } catch(err){}
    apply(next);
  });
  document.addEventListener("DOMContentLoaded", function(){ apply(root.getAttribute("data-theme")); });
})();
