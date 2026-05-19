document.getElementById("open")?.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("scraper.html") });
});
