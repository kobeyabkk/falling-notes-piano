// src/main.jsx
import React, { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";

// React を起動
const container = document.getElementById("root");
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
);

if (typeof window !== "undefined" && "serviceWorker" in navigator) {
  let initialControllerHandled = false;
  const emit = window.__fnpwa?.emit;
  const dispatch = (detail) => {
    if (typeof emit === "function") {
      emit("fnpwa:controllerchange", detail);
    } else {
      window.dispatchEvent(new CustomEvent("fnpwa:controllerchange", { detail }));
    }
  };

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    const detail = { controller: navigator.serviceWorker.controller };
    dispatch(detail);
    if (!initialControllerHandled) {
      initialControllerHandled = true;
    }
  });

  navigator.serviceWorker.ready
    .then(() => window.__fnpwa?.requestOfflineStatus?.())
    .catch(() => {});
}

/*
  ※ SW（サービスワーカー）の登録は index.html 側で実行しています。
     main.jsx では登録しません（重複を避けるため）。
*/
