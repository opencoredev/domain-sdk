import { Window } from "happy-dom";

const testWindow = new Window({ url: "https://example.test" });
Object.assign(globalThis, {
  window: testWindow,
  document: testWindow.document,
  navigator: testWindow.navigator,
  HTMLElement: testWindow.HTMLElement,
  HTMLButtonElement: testWindow.HTMLButtonElement,
  FormData: testWindow.FormData,
});
