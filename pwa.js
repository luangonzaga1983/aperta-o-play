(() => {
  const storage_key = "pwa_install_dismissed_at";
  const cooldown_milliseconds = 3 * 24 * 60 * 60 * 1000;
  const app_name = "Aperta o Play";

  let deferred_prompt = null;

  const is_standalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  const is_ios = /iphone|ipad|ipod/i.test(window.navigator.userAgent) && !window.MSStream;

  const read_dismissed_at = () => {
    try {
      return Number(window.localStorage.getItem(storage_key)) || 0;
    } catch (error) {
      return 0;
    }
  };

  const write_dismissed_at = () => {
    try {
      window.localStorage.setItem(storage_key, String(Date.now()));
    } catch (error) {
      return;
    }
  };

  const add_head_tag = (tag_name, attributes) => {
    const element = document.createElement(tag_name);
    Object.keys(attributes).forEach((key) => element.setAttribute(key, attributes[key]));
    document.head.appendChild(element);
  };

  const inject_head = () => {
    if (!document.querySelector("link[rel='manifest']")) add_head_tag("link", { rel: "manifest", href: "/manifest.json" });
    if (!document.querySelector("meta[name='theme-color']")) add_head_tag("meta", { name: "theme-color", content: "#04110d" });
    if (!document.querySelector("link[rel='apple-touch-icon']")) add_head_tag("link", { rel: "apple-touch-icon", href: "/icons/apple-touch-icon.png" });
    add_head_tag("meta", { name: "apple-mobile-web-app-capable", content: "yes" });
    add_head_tag("meta", { name: "mobile-web-app-capable", content: "yes" });
    add_head_tag("meta", { name: "apple-mobile-web-app-title", content: app_name });
    add_head_tag("meta", { name: "apple-mobile-web-app-status-bar-style", content: "black-translucent" });
  };

  const register_service_worker = () => {
    if (!("serviceWorker" in navigator)) return;
    window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
  };

  const inject_styles = () => {
    const style = document.createElement("style");
    style.textContent = `
      #pwa-banner{position:fixed;left:12px;right:12px;bottom:calc(12px + env(safe-area-inset-bottom,0px));z-index:2147483000;max-width:420px;margin:0 auto;display:flex;align-items:center;gap:12px;padding:12px 14px;border-radius:18px;background:#0b1d1a;border:1px solid rgba(47,224,143,.45);box-shadow:0 12px 40px -10px rgba(0,0,0,.8),0 0 28px -10px rgba(47,224,143,.5);color:#fff;font-family:Outfit,system-ui,sans-serif;transform:translateY(140%);transition:transform .35s cubic-bezier(.2,.8,.2,1)}
      #pwa-banner.visible{transform:translateY(0)}
      #pwa-banner img{width:46px;height:46px;border-radius:12px;flex:none}
      #pwa-banner .pwa-text{flex:1;min-width:0}
      #pwa-banner .pwa-title{font-size:15px;font-weight:700;line-height:1.2}
      #pwa-banner .pwa-subtitle{font-size:12px;color:#7d9a8c;line-height:1.3;margin-top:2px}
      #pwa-banner button{border:0;cursor:pointer;font-family:inherit}
      #pwa-banner .pwa-install{padding:10px 14px;border-radius:12px;background:#3be7a2;color:#04110d;font-size:13px;font-weight:700}
      #pwa-banner .pwa-close{width:28px;height:28px;border-radius:50%;background:transparent;color:#7d9a8c;font-size:18px;line-height:1}
      #pwa-banner:focus-within{outline:2px solid #3be7a2;outline-offset:2px}
      @media (prefers-reduced-motion:reduce){#pwa-banner{transition:none}}
    `;
    document.head.appendChild(style);
  };

  const hide_banner = (banner) => {
    banner.classList.remove("visible");
    setTimeout(() => banner.remove(), 400);
  };

  const show_banner = () => {
    if (is_standalone) return;
    if (Date.now() - read_dismissed_at() < cooldown_milliseconds) return;
    if (!is_ios && !deferred_prompt) return;
    if (document.getElementById("pwa-banner")) return;

    const subtitle = is_ios ? "Toque em Compartilhar e depois em Adicionar à Tela de Início" : "Instale grátis e abra direto da tela inicial";
    const banner = document.createElement("div");
    banner.id = "pwa-banner";
    banner.setAttribute("role", "dialog");
    banner.setAttribute("aria-label", "Instalar aplicativo");
    banner.innerHTML = `
      <img src="/icons/icon-192.png" alt="">
      <div class="pwa-text">
        <div class="pwa-title">Instalar ${app_name}</div>
        <div class="pwa-subtitle">${subtitle}</div>
      </div>
      ${is_ios ? "" : '<button class="pwa-install" type="button">Instalar</button>'}
      <button class="pwa-close" type="button" aria-label="Fechar">×</button>
    `;
    document.body.appendChild(banner);
    requestAnimationFrame(() => banner.classList.add("visible"));

    banner.querySelector(".pwa-close").addEventListener("click", () => {
      write_dismissed_at();
      hide_banner(banner);
    });

    const install_button = banner.querySelector(".pwa-install");
    if (!install_button) return;

    install_button.addEventListener("click", async () => {
      if (!deferred_prompt) return;
      deferred_prompt.prompt();
      const choice = await deferred_prompt.userChoice;
      if (choice.outcome !== "accepted") write_dismissed_at();
      deferred_prompt = null;
      hide_banner(banner);
    });
  };

  const start = () => {
    inject_head();
    register_service_worker();
    if (is_standalone) return;
    inject_styles();

    window.addEventListener("beforeinstallprompt", (event) => {
      event.preventDefault();
      deferred_prompt = event;
      setTimeout(show_banner, 1500);
    });

    window.addEventListener("appinstalled", () => {
      const banner = document.getElementById("pwa-banner");
      if (banner) hide_banner(banner);
      deferred_prompt = null;
    });

    if (is_ios) setTimeout(show_banner, 2500);
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
