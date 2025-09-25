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

/*
  ※ SW（サービスワーカー）の登録は index.html 側で実行しています。
     main.jsx では登録しません（重複を避けるため）。
*/
