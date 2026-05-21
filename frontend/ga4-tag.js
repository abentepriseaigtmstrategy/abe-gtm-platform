(function () {
  const GA4_ID = 'G-KBPQTQPSZH';
  if (window.__ABE_GA4_LOADED__) return;
  window.__ABE_GA4_LOADED__ = true;
  const script = document.createElement('script');
  script.async = true;
  script.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA4_ID;
  document.head.appendChild(script);
  window.dataLayer = window.dataLayer || [];
  function gtag(){ window.dataLayer.push(arguments); }
  window.gtag = window.gtag || gtag;
  window.gtag('js', new Date());
  window.gtag('config', GA4_ID);
})();
