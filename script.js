/* ============================================================================
   L'Oréal Smart Routine & Product Advisor
   Plain JavaScript (no imports/exports, beginner-friendly & commented)
   ============================================================================ */

/* Endpoint URL for our AI routine & chat advisor.
   Uses our local Express proxy (/api/chat), which forwards the messages array
   to the AI model with real-time search grounding. If you deploy your own
   Cloudflare Worker, you can replace this URL with your Worker URL. */
const API_ENDPOINT = "/api/chat";

/* localStorage keys for persisting user selections and RTL layout mode */
const STORAGE_KEYS = {
  selectedProducts: "loreal_selected_products",
  rtlMode: "loreal_rtl_mode",
};

/* System prompt guiding the beauty advisor on topic boundaries and helpfulness */
const SYSTEM_PROMPT = [
  "You are an expert L'Oréal beauty, skincare, haircare, makeup, suncare, men's grooming, and fragrance advisor.",
  "When asked to generate a routine, organize it clearly into Morning (AM) and Evening (PM) or step-by-step order using ONLY the products the user selected, explaining how and why each product fits the order.",
  "For follow-up questions, answer using the full conversation context and keep all advice focused on the generated routine, L'Oréal group products, skincare, haircare, hair color, hair styling, makeup, suncare, men's grooming, or fragrance.",
  "If the user asks about unrelated topics (like coding, math, politics, or general trivia), politely explain that you specialize in L'Oréal beauty routines and invite them to ask a beauty or product question instead.",
  "When web search grounding is enabled, incorporate up-to-date product facts or routine guidance concisely.",
].join(" ");

/* DOM element references */
const categoryFilter = document.getElementById("categoryFilter");
const productSearch = document.getElementById("productSearch");
const clearSearchBtn = document.getElementById("clearSearchBtn");
const productsContainer = document.getElementById("productsContainer");
const catalogCount = document.getElementById("catalogCount");

const selectedProductsList = document.getElementById("selectedProductsList");
const selectedCount = document.getElementById("selectedCount");
const clearAllBtn = document.getElementById("clearAllBtn");
const generateRoutineBtn = document.getElementById("generateRoutine");
const headerCta = document.getElementById("headerCta");

const chatWindow = document.getElementById("chatWindow");
const chatForm = document.getElementById("chatForm");
const userInput = document.getElementById("userInput");
const sendBtn = document.getElementById("sendBtn");

const rtlToggle = document.getElementById("rtlToggle");
const rtlToggleLabel = document.getElementById("rtlToggleLabel");
const webSearchToggle = document.getElementById("webSearchToggle");
const webSearchLabel = document.getElementById("webSearchLabel");

/* Modal DOM references for revealing product descriptions */
const productModal = document.getElementById("productModal");
const closeModalBtn = document.getElementById("closeModalBtn");
const modalCloseSecondaryBtn = document.getElementById("modalCloseSecondaryBtn");
const modalImageStage = document.getElementById("modalImageStage");
const modalImage = document.getElementById("modalImage");
const modalMeta = document.getElementById("modalMeta");
const modalTitle = document.getElementById("modalTitle");
const modalDescription = document.getElementById("modalDescription");
const modalToggleSelectBtn = document.getElementById("modalToggleSelectBtn");

/* Application state */
let allProducts = [];
let selectedProducts = [];
let conversationHistory = [{ role: "system", content: SYSTEM_PROMPT }];
let webSearchEnabled = true;
let activeModalProductId = null;
let lastFocusedElement = null;

/* ============================================================================
   1. Security & Formatting Helpers
   ============================================================================ */

/* Escape raw HTML characters before inserting user or AI strings into markup */
function escapeHTML(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* Convert plain markdown-like AI responses into clean, safe HTML */
function formatMessageHTML(rawText) {
  const safeText = escapeHTML(rawText);
  const lines = safeText.split(/\r?\n/);
  let html = "";
  let inList = false;
  let listTag = "ul";

  const applyInlineFormatting = (line) => {
    let formatted = line.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    /* Allow safe http(s) markdown links */
    formatted = formatted.replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
    );
    return formatted;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line) {
      if (inList) {
        html += `</${listTag}>`;
        inList = false;
      }
      continue;
    }

    /* Headings (### or ##) */
    const headingMatch = line.match(/^#{2,4}\s+(.+)$/);
    if (headingMatch) {
      if (inList) {
        html += `</${listTag}>`;
        inList = false;
      }
      html += `<h4>${applyInlineFormatting(headingMatch[1])}</h4>`;
      continue;
    }

    /* Bullet list item */
    const bulletMatch = line.match(/^[-*•]\s+(.+)$/);
    if (bulletMatch) {
      if (!inList || listTag !== "ul") {
        if (inList) html += `</${listTag}>`;
        listTag = "ul";
        html += "<ul>";
        inList = true;
      }
      html += `<li>${applyInlineFormatting(bulletMatch[1])}</li>`;
      continue;
    }

    /* Numbered list item */
    const numberedMatch = line.match(/^\d+\.\s+(.+)$/);
    if (numberedMatch) {
      if (!inList || listTag !== "ol") {
        if (inList) html += `</${listTag}>`;
        listTag = "ol";
        html += "<ol>";
        inList = true;
      }
      html += `<li>${applyInlineFormatting(numberedMatch[1])}</li>`;
      continue;
    }

    /* Regular paragraph */
    if (inList) {
      html += `</${listTag}>`;
      inList = false;
    }
    html += `<p>${applyInlineFormatting(line)}</p>`;
  }

  if (inList) {
    html += `</${listTag}>`;
  }

  return html || `<p>${safeText}</p>`;
}

/* Format category slugs into clean human-readable labels */
function formatCategoryLabel(category) {
  const labels = {
    cleanser: "Cleanser",
    moisturizer: "Moisturizer",
    skincare: "Skincare Treatment",
    suncare: "Suncare",
    haircare: "Haircare",
    "hair color": "Hair Color",
    "hair styling": "Hair Styling",
    makeup: "Makeup",
    "men's grooming": "Men's Grooming",
    fragrance: "Fragrance",
  };
  return labels[category] || category;
}

/* ============================================================================
   2. localStorage Persistence (Selected Products + RTL Preference)
   ============================================================================ */

/* Save the current selectedProducts array to localStorage */
function saveSelectedProducts() {
  try {
    localStorage.setItem(
      STORAGE_KEYS.selectedProducts,
      JSON.stringify(selectedProducts)
    );
  } catch (error) {
    console.warn("Could not save selections to localStorage:", error);
  }
}

/* Load any previously saved products from localStorage */
function loadSavedProducts() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.selectedProducts);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.warn("Could not read selections from localStorage:", error);
    return [];
  }
}

/* Apply RTL or LTR direction and persist preference */
function applyDirection(isRtl) {
  const dir = isRtl ? "rtl" : "ltr";
  document.documentElement.setAttribute("dir", dir);
  rtlToggle.setAttribute("aria-pressed", String(isRtl));
  rtlToggleLabel.textContent = isRtl ? "LTR Mode" : "RTL Mode";
  try {
    localStorage.setItem(STORAGE_KEYS.rtlMode, String(isRtl));
  } catch (error) {
    console.warn("Could not save RTL preference:", error);
  }
}

/* ============================================================================
   3. Product Loading, Filtering & Grid Rendering
   ============================================================================ */

/* Fetch product catalog from products.json */
async function loadProducts() {
  const response = await fetch("products.json");
  if (!response.ok) {
    throw new Error("Failed to load product catalog.");
  }
  const data = await response.json();
  return data.products || [];
}

/* Check whether a product ID is currently selected */
function isProductSelected(productId) {
  return selectedProducts.some((item) => item.id === productId);
}

/* Filter products using both Category Filter and Product Search input */
function getFilteredProducts() {
  const selectedCategory = categoryFilter.value;
  const searchQuery = productSearch.value.trim().toLowerCase();

  return allProducts.filter((product) => {
    const matchesCategory =
      !selectedCategory || product.category === selectedCategory;

    if (!searchQuery) {
      return matchesCategory;
    }

    const haystack = [
      product.name,
      product.brand,
      product.category,
      product.description,
    ]
      .join(" ")
      .toLowerCase();

    return matchesCategory && haystack.includes(searchQuery);
  });
}

/* Render product cards inside the grid */
function displayProducts(products) {
  catalogCount.textContent = `Showing ${products.length} of ${allProducts.length} products`;

  if (products.length === 0) {
    productsContainer.innerHTML = `
      <div class="placeholder-message">
        No matching products found. Try another keyword or switch categories.
      </div>
    `;
    return;
  }

  productsContainer.innerHTML = products
    .map((product) => {
      const selected = isProductSelected(product.id);
      const safeName = escapeHTML(product.name);
      const safeBrand = escapeHTML(product.brand);
      const safeCategory = escapeHTML(formatCategoryLabel(product.category));
      const safeImage = escapeHTML(product.image);

      return `
        <article
          class="product-card ${selected ? "is-selected" : ""}"
          data-product-id="${product.id}"
          tabindex="0"
          role="button"
          aria-pressed="${selected}"
          aria-label="${safeName} by ${safeBrand}. ${selected ? "Selected. Click to remove." : "Click to select."}"
        >
          <div class="product-image-stage">
            <img
              src="${safeImage}"
              alt="${safeName}"
              referrerpolicy="no-referrer"
              loading="lazy"
            />
          </div>
          <div class="product-card-body">
            <p class="product-meta">${safeBrand} · ${safeCategory}</p>
            <h3>${safeName}</h3>
            <div class="product-card-footer">
              <span class="select-status">
                <span class="select-status-dot" aria-hidden="true">
                  ${selected ? '<i class="fa-solid fa-check"></i>' : ""}
                </span>
                <span>${selected ? "Selected" : "Select"}</span>
              </span>
              <button
                type="button"
                class="details-btn"
                data-action="details"
                data-product-id="${product.id}"
              >
                Details
              </button>
            </div>
          </div>
        </article>
      `;
    })
    .join("");

  /* Attach graceful fallback handlers for any images that fail to load */
  const cardImages = productsContainer.querySelectorAll(".product-image-stage img");
  cardImages.forEach((img) => {
    img.addEventListener("error", () => {
      const stage = img.parentElement;
      if (!stage) return;
      const altText = escapeHTML(img.alt || "L'Oréal Product");
      stage.innerHTML = `
        <div class="image-fallback">
          <i class="fa-solid fa-pump-soap" aria-hidden="true"></i>
          <span>${altText}</span>
        </div>
      `;
    });
  });
}

/* ============================================================================
   4. Product Selection & Selected Products Workbench
   ============================================================================ */

/* Toggle selection state for a product by ID */
function toggleProductSelection(productId) {
  const existingIndex = selectedProducts.findIndex(
    (item) => item.id === productId
  );

  if (existingIndex !== -1) {
    selectedProducts.splice(existingIndex, 1);
  } else {
    const product = allProducts.find((item) => item.id === productId);
    if (product) {
      selectedProducts.push(product);
    }
  }

  saveSelectedProducts();
  renderSelectedProducts();
  displayProducts(getFilteredProducts());

  /* Keep modal button synchronized if the modal is currently open for this item */
  if (activeModalProductId === productId) {
    updateModalSelectButton(productId);
  }
}

/* Render the "Selected Products" panel with remove & clear-all controls */
function renderSelectedProducts() {
  const count = selectedProducts.length;
  selectedCount.textContent = `${count} ${count === 1 ? "product" : "products"} selected`;
  clearAllBtn.hidden = count === 0;

  if (count === 0) {
    selectedProductsList.innerHTML = `
      <div class="selected-empty">
        Select products from the catalog to build your personalized routine.
      </div>
    `;
    return;
  }

  selectedProductsList.innerHTML = selectedProducts
    .map((product) => {
      const safeName = escapeHTML(product.name);
      const safeBrand = escapeHTML(product.brand);
      const safeImage = escapeHTML(product.image);

      return `
        <div class="selected-item" data-selected-id="${product.id}">
          <img
            src="${safeImage}"
            alt="${safeName}"
            class="selected-item-thumb"
            referrerpolicy="no-referrer"
          />
          <div class="selected-item-info">
            <div class="selected-item-name">${safeName}</div>
            <div class="selected-item-brand">${safeBrand}</div>
          </div>
          <button
            type="button"
            class="remove-item-btn"
            data-remove-id="${product.id}"
            aria-label="Remove ${safeName} from routine"
            title="Remove product"
          >
            <i class="fa-solid fa-xmark" aria-hidden="true"></i>
          </button>
        </div>
      `;
    })
    .join("");
}

/* Clear all selected products from state and localStorage */
function clearAllSelectedProducts() {
  selectedProducts = [];
  saveSelectedProducts();
  renderSelectedProducts();
  displayProducts(getFilteredProducts());
}

/* ============================================================================
   5. Accessible Product Description Modal
   ============================================================================ */

function updateModalSelectButton(productId) {
  const selected = isProductSelected(productId);
  modalToggleSelectBtn.textContent = selected
    ? "Remove from Routine"
    : "Add to Routine";
  modalToggleSelectBtn.classList.toggle("is-remove", selected);
}

function openProductModal(productId) {
  const product = allProducts.find((item) => item.id === productId);
  if (!product) return;

  activeModalProductId = productId;
  lastFocusedElement = document.activeElement;

  modalMeta.textContent = `${product.brand} · ${formatCategoryLabel(product.category)}`;
  modalTitle.textContent = product.name;
  modalDescription.textContent = product.description;

  /* Reset image stage and attach error fallback */
  modalImageStage.innerHTML = "";
  const img = document.createElement("img");
  img.id = "modalImage";
  img.src = product.image;
  img.alt = product.name;
  img.setAttribute("referrerpolicy", "no-referrer");
  img.addEventListener("error", () => {
    modalImageStage.innerHTML = `
      <div class="image-fallback">
        <i class="fa-solid fa-pump-soap" aria-hidden="true"></i>
        <span>${escapeHTML(product.name)}</span>
      </div>
    `;
  });
  modalImageStage.appendChild(img);

  updateModalSelectButton(productId);
  productModal.hidden = false;
  closeModalBtn.focus();
}

function closeProductModal() {
  productModal.hidden = true;
  activeModalProductId = null;
  if (lastFocusedElement && typeof lastFocusedElement.focus === "function") {
    lastFocusedElement.focus();
  }
}

/* ============================================================================
   6. Chat UI & AI Advisor Integration (Routine Generation + Follow-Up Chat)
   ============================================================================ */

/* Append a user, assistant, or error message to the chat window */
function appendChatMessage(role, text, sources = []) {
  const msgEl = document.createElement("div");
  msgEl.className = `chat-msg ${role}`;

  const roleLabel =
    role === "user"
      ? "You"
      : role === "error"
      ? "Notice"
      : "L'Oréal Advisor";

  let sourcesHTML = "";
  if (role === "assistant" && Array.isArray(sources) && sources.length > 0) {
    const links = sources
      .map(
        (src) => `
          <li>
            <a href="${escapeHTML(src.uri)}" target="_blank" rel="noopener noreferrer">
              <i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i>
              <span>${escapeHTML(src.title)}</span>
            </a>
          </li>
        `
      )
      .join("");

    sourcesHTML = `
      <div class="chat-sources">
        <div class="chat-sources-label">Web Sources</div>
        <ul class="chat-sources-list">${links}</ul>
      </div>
    `;
  }

  msgEl.innerHTML = `
    <div class="chat-msg-role">${roleLabel}</div>
    <div class="chat-msg-content">${formatMessageHTML(text)}</div>
    ${sourcesHTML}
  `;

  chatWindow.appendChild(msgEl);
  chatWindow.scrollTop = chatWindow.scrollHeight;
  return msgEl;
}

/* Show a loading bubble in the chat window while awaiting the API */
function appendLoadingMessage(labelText) {
  const loadingEl = document.createElement("div");
  loadingEl.className = "chat-msg assistant";
  loadingEl.innerHTML = `
    <div class="chat-msg-role">L'Oréal Advisor</div>
    <div class="chat-loading">
      <i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i>
      <span>${escapeHTML(labelText)}</span>
    </div>
  `;
  chatWindow.appendChild(loadingEl);
  chatWindow.scrollTop = chatWindow.scrollHeight;
  return loadingEl;
}

/* Toggle interactive state of chat & generate buttons while a request runs */
function setRequestBusy(isBusy) {
  generateRoutineBtn.disabled = isBusy;
  sendBtn.disabled = isBusy;
  userInput.disabled = isBusy;
}

/* Send conversationHistory to the backend Worker/API endpoint */
async function sendChatRequest(loadingText) {
  setRequestBusy(true);
  const loadingEl = appendLoadingMessage(loadingText);

  try {
    const response = await fetch(API_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: conversationHistory,
        webSearch: webSearchEnabled,
      }),
    });

    const data = await response.json();
    loadingEl.remove();

    if (!response.ok) {
      throw new Error(data?.error || "Unable to reach the beauty advisor.");
    }

    const reply = data?.choices?.[0]?.message?.content;
    if (!reply) {
      throw new Error("The advisor returned an empty response.");
    }

    /* Save assistant reply in conversationHistory so follow-ups keep context */
    conversationHistory.push({
      role: "assistant",
      content: reply,
    });

    appendChatMessage("assistant", reply, data.sources || []);
  } catch (error) {
    loadingEl.remove();
    appendChatMessage(
      "error",
      error?.message || "Something went wrong. Please try again."
    );
  } finally {
    setRequestBusy(false);
  }
}

/* Generate a personalized routine from ONLY the selected products */
async function handleGenerateRoutine() {
  if (selectedProducts.length === 0) {
    appendChatMessage(
      "error",
      "Please select at least one product from the catalog before generating a routine."
    );
    chatWindow.scrollIntoView({ behavior: "smooth", block: "nearest" });
    return;
  }

  /* Prepare clean JSON payload containing only the selected product details */
  const selectedPayload = selectedProducts.map((product) => ({
    name: product.name,
    brand: product.brand,
    category: product.category,
    description: product.description,
  }));

  const userDisplayMessage = `Generate a personalized routine for my ${selectedPayload.length} selected ${
    selectedPayload.length === 1 ? "product" : "products"
  }: ${selectedPayload.map((p) => p.name).join(", ")}.`;

  const apiPrompt = [
    "Build a personalized beauty routine using ONLY these selected products (provided as JSON):",
    JSON.stringify(selectedPayload, null, 2),
    "Include step-by-step usage order (AM/PM or sequence where appropriate), brief application tips, and any helpful layering notes.",
  ].join("\n\n");

  /* Reset conversation to system prompt + new routine request so the AI focuses cleanly on current selections */
  conversationHistory = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: apiPrompt },
  ];

  appendChatMessage("user", userDisplayMessage);
  await sendChatRequest(
    webSearchEnabled
      ? "Researching formulas & building your personalized routine…"
      : "Building your personalized routine…"
  );
}

/* Handle follow-up questions in the chatbox */
async function handleChatSubmit(event) {
  event.preventDefault();
  const question = userInput.value.trim();
  if (!question) return;

  userInput.value = "";
  appendChatMessage("user", question);

  /* Push new user message onto conversationHistory for full context */
  conversationHistory.push({
    role: "user",
    content: question,
  });

  await sendChatRequest(
    webSearchEnabled
      ? "Searching & preparing your beauty advice…"
      : "Thinking…"
  );
}

/* ============================================================================
   7. Event Listeners & Initialization
   ============================================================================ */

/* Filter grid when category changes */
categoryFilter.addEventListener("change", () => {
  displayProducts(getFilteredProducts());
});

/* Live product search filtering as the user types */
productSearch.addEventListener("input", () => {
  clearSearchBtn.hidden = productSearch.value.trim().length === 0;
  displayProducts(getFilteredProducts());
});

/* Clear search input button */
clearSearchBtn.addEventListener("click", () => {
  productSearch.value = "";
  clearSearchBtn.hidden = true;
  displayProducts(getFilteredProducts());
  productSearch.focus();
});

/* Delegate clicks inside the products grid (Details button vs Card selection) */
productsContainer.addEventListener("click", (event) => {
  const detailsBtn = event.target.closest('[data-action="details"]');
  if (detailsBtn) {
    event.stopPropagation();
    const productId = Number(detailsBtn.dataset.productId);
    openProductModal(productId);
    return;
  }

  const card = event.target.closest(".product-card");
  if (card) {
    const productId = Number(card.dataset.productId);
    toggleProductSelection(productId);
  }
});

/* Keyboard support for selecting product cards with Enter or Space */
productsContainer.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  if (event.target.closest('[data-action="details"]')) return;

  const card = event.target.closest(".product-card");
  if (card) {
    event.preventDefault();
    const productId = Number(card.dataset.productId);
    toggleProductSelection(productId);
  }
});

/* Remove individual item from Selected Products list */
selectedProductsList.addEventListener("click", (event) => {
  const removeBtn = event.target.closest("[data-remove-id]");
  if (!removeBtn) return;
  const productId = Number(removeBtn.dataset.removeId);
  toggleProductSelection(productId);
});

/* Clear all selected products */
clearAllBtn.addEventListener("click", clearAllSelectedProducts);

/* Generate Routine button */
generateRoutineBtn.addEventListener("click", handleGenerateRoutine);

/* Header CTA smoothly scrolls to routine workbench or triggers generation */
headerCta.addEventListener("click", () => {
  document
    .getElementById("selected-routine")
    .scrollIntoView({ behavior: "smooth", block: "start" });
});

/* Chat form submit */
chatForm.addEventListener("submit", handleChatSubmit);

/* RTL mode toggle */
rtlToggle.addEventListener("click", () => {
  const isCurrentlyRtl = document.documentElement.getAttribute("dir") === "rtl";
  applyDirection(!isCurrentlyRtl);
});

/* Web Search grounding toggle */
webSearchToggle.addEventListener("click", () => {
  webSearchEnabled = !webSearchEnabled;
  webSearchToggle.setAttribute("aria-pressed", String(webSearchEnabled));
  webSearchLabel.textContent = webSearchEnabled
    ? "Web Search: On"
    : "Web Search: Off";
});

/* Modal interactions */
closeModalBtn.addEventListener("click", closeProductModal);
modalCloseSecondaryBtn.addEventListener("click", closeProductModal);
modalToggleSelectBtn.addEventListener("click", () => {
  if (activeModalProductId !== null) {
    toggleProductSelection(activeModalProductId);
  }
});
productModal.addEventListener("click", (event) => {
  if (event.target === productModal) {
    closeProductModal();
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !productModal.hidden) {
    closeProductModal();
  }
});

/* Initialize app on page load */
async function initApp() {
  /* Restore RTL setting from localStorage */
  try {
    const savedRtl = localStorage.getItem(STORAGE_KEYS.rtlMode) === "true";
    applyDirection(savedRtl);
  } catch {
    applyDirection(false);
  }

  /* Restore saved product selections from localStorage immediately */
  selectedProducts = loadSavedProducts();
  renderSelectedProducts();

  /* Show welcoming starter message in the chat window */
  appendChatMessage(
    "assistant",
    "Welcome to the L'Oréal Smart Routine & Product Advisor. Select products from the catalog and click **Generate Routine**, or ask any question about skincare, haircare, makeup, or fragrance."
  );

  /* Load catalog products and render grid */
  try {
    allProducts = await loadProducts();
    /* Refresh saved product objects against the latest catalog data */
    if (selectedProducts.length > 0) {
      const savedIds = new Set(selectedProducts.map((item) => item.id));
      selectedProducts = allProducts.filter((item) => savedIds.has(item.id));
      saveSelectedProducts();
      renderSelectedProducts();
    }
    displayProducts(getFilteredProducts());
  } catch (error) {
    catalogCount.textContent = "Catalog unavailable";
    productsContainer.innerHTML = `
      <div class="placeholder-message">
        Unable to load products right now. Please refresh the page.
      </div>
    `;
    console.error(error);
  }
}

initApp();
