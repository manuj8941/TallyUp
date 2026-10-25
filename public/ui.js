// =========================================================================
// TALLYUP — APPLE iOS 18 SYSTEM ENGINE
// Haptics, Zero-Zoom, Auto Dark Mode, Modals, Branding & Navigation
// =========================================================================

// --- 1. APPLE & ANDROID ADAPTIVE HAPTIC ENGINE ---
let audioCtx = null;

function playHapticTickSound() {
  try {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(140, audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(30, audioCtx.currentTime + 0.025);
    gain.gain.setValueAtTime(0.06, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.025);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.025);
  } catch (e) {
    // AudioContext blocked or silent mode
  }
}

function triggerHaptic(style = 'light') {
  // Always synthesize tactile tick audio
  playHapticTickSound();

  if ('vibrate' in navigator) {
    try {
      // Modern Android ERM/LRA motors require >= 35ms pulse duration to overcome physical inertia
      if (style === 'selection') navigator.vibrate(30);
      else if (style === 'light') navigator.vibrate(40);
      else if (style === 'medium') navigator.vibrate(75);
      else if (style === 'heavy') navigator.vibrate(120);
      else if (style === 'success') navigator.vibrate([45, 60, 50]);
      else if (style === 'error') navigator.vibrate([60, 50, 60, 50, 90]);
      else navigator.vibrate(40);
    } catch (e) {
      // ignore
    }
  }
}

window.triggerHaptic = triggerHaptic;

// --- 2. HAPTIC TOAST HUD NOTIFICATIONS ---
let hapticPillTimeout = null;

function showHapticToast(label, text) {
  let pill = document.getElementById('ios-haptic-pill');
  if (!pill) {
    pill = document.createElement('div');
    pill.id = 'ios-haptic-pill';
    pill.className = 'ios-haptic-pill';
    pill.innerHTML = `<span id="haptic-pill-icon">📳</span> <span id="haptic-pill-text"></span>`;
    document.body.appendChild(pill);
  }
  
  const icon = document.getElementById('haptic-pill-icon');
  const txt = document.getElementById('haptic-pill-text');
  
  if (label && (label.includes('Copied') || label.includes('📋'))) icon.textContent = '📋';
  else if (label && label.includes('Dark')) icon.textContent = '🌙';
  else if (label && label.includes('Light')) icon.textContent = '☀️';
  else if (label && label.includes('Success')) icon.textContent = '✅';
  else icon.textContent = '📳';

  txt.textContent = text || label || '';
  pill.classList.add('show');
  
  clearTimeout(hapticPillTimeout);
  hapticPillTimeout = setTimeout(() => {
    pill.classList.remove('show');
  }, 2400);
}

window.showHapticToast = showHapticToast;

// --- 3. 1-TAP COPY HELPER ---
function copyToClipboard(text, label) {
  triggerHaptic('success');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => {
      showHapticToast('📋 Copied!', `${label || 'Item'} (${text}) copied to clipboard`);
    }).catch(() => {
      fallbackCopy(text, label);
    });
  } else {
    fallbackCopy(text, label);
  }
}

function fallbackCopy(text, label) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try {
    document.execCommand('copy');
    showHapticToast('📋 Copied!', `${label || 'Item'} (${text}) copied`);
  } catch (err) {}
  document.body.removeChild(ta);
}

window.copyToClipboard = copyToClipboard;

// --- 4. STRICT ZERO-ZOOM ENGINE (Mobile, Touchpads & Laptops) ---
(function initZeroZoom() {
  // 1. Prevent Trackpad Pinch & Ctrl + Mouse Wheel Zoom
  window.addEventListener('wheel', (event) => {
    if (event.ctrlKey) {
      event.preventDefault();
    }
  }, { passive: false });

  // 2. Prevent Keyboard Zoom Shortcuts (Ctrl/Cmd + Plus, Minus, Zero)
  window.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && (
      event.key === '+' || 
      event.key === '-' || 
      event.key === '=' || 
      event.key === '_' || 
      event.key === '0' ||
      event.keyCode === 187 || 
      event.keyCode === 189 || 
      event.keyCode === 107 || 
      event.keyCode === 109 || 
      event.keyCode === 96  || 
      event.keyCode === 48
    )) {
      event.preventDefault();
    }
  });

  // 3. Prevent Safari / iOS Trackpad & Multi-touch Gesture Pinch Zoom
  document.addEventListener('gesturestart', (e) => e.preventDefault(), { passive: false });
  document.addEventListener('gesturechange', (e) => e.preventDefault(), { passive: false });
  document.addEventListener('gestureend', (e) => e.preventDefault(), { passive: false });

  // 4. Prevent Multi-Finger Pinch Zoom on Mobile & Touchscreen Laptops
  document.addEventListener('touchstart', (event) => {
    if (event.touches && event.touches.length > 1) {
      event.preventDefault();
    }
  }, { passive: false });

  document.addEventListener('touchmove', (event) => {
    if (event.touches && event.touches.length > 1) {
      event.preventDefault();
    }
  }, { passive: false });

  // 5. Prevent Fast Double-Tap to Zoom on Mobile Browsers
  let lastTouchTime = 0;
  document.addEventListener('touchend', (event) => {
    const now = Date.now();
    if (now - lastTouchTime <= 280) {
      if (event.target.tagName !== 'INPUT' && event.target.tagName !== 'TEXTAREA') {
        event.preventDefault();
      }
    }
    lastTouchTime = now;
  }, { passive: false });

  // 6. Prevent Double-Click Zoom on Desktop / Laptop Touchpads
  window.addEventListener('dblclick', (event) => {
    if (event.target.tagName !== 'INPUT' && event.target.tagName !== 'TEXTAREA') {
      event.preventDefault();
    }
  }, { passive: false });
})();

// --- 5. AUTOMATIC DARK MODE ENGINE ---
let currentThemePreference = localStorage.getItem('tallyup_theme_pref') || 'system';
const darkModeQuery = window.matchMedia('(prefers-color-scheme: dark)');

function applyTheme(pref) {
  currentThemePreference = pref;
  localStorage.setItem('tallyup_theme_pref', pref);

  if (pref === 'system') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', pref);
  }

  // Update any theme toggles in page if they exist
  const toggles = document.querySelectorAll('.dark-mode-toggle');
  const isDark = pref === 'dark' || (pref === 'system' && darkModeQuery.matches);
  toggles.forEach(t => t.checked = isDark);
}

darkModeQuery.addEventListener('change', (e) => {
  if (currentThemePreference === 'system') {
    applyTheme('system');
  }
});

applyTheme(currentThemePreference);
window.applyTheme = applyTheme;
window.toggleDarkMode = function() {
  triggerHaptic('selection');
  const next = (currentThemePreference === 'dark') ? 'light' : 'dark';
  applyTheme(next);
  showHapticToast(next === 'dark' ? '🌙 Dark Mode' : '☀️ Light Mode', next === 'dark' ? 'Dark Mode active' : 'Light Mode active');
};

// --- 6. GLOBAL TAP HAPTICS DELEGATION ---
document.addEventListener('click', (e) => {
  const target = e.target.closest('button, .btn, .bottom-nav-item, .cal-day, .copy-badge, a');
  if (target) {
    if (target.classList.contains('reject-btn') || target.classList.contains('btn-danger')) {
      triggerHaptic('medium');
    } else if (target.classList.contains('approve-btn') || target.classList.contains('btn-primary')) {
      triggerHaptic('success');
    } else {
      triggerHaptic('light');
    }
  }
});

// --- 7. MODAL UTILITY (Upgraded to Apple Inset Dialogs) ---
(function () {
  function ensureModal() {
    if (document.getElementById('app-modal')) return;
    const modal = document.createElement('div');
    modal.id = 'app-modal';
    modal.className = 'modal';
    modal.innerHTML = `
      <div class="modal-content card">
        <p id="app-modal-message" style="margin-top:0;font-size:1.02rem;font-weight:600;line-height:1.4;"></p>
        <div style="margin-top:16px"><button id="app-modal-ok" class="btn">OK</button></div>
      </div>
    `;
    document.body.appendChild(modal);
  }

  function showAppModal(message, type, onClose) {
    ensureModal();
    const modal = document.getElementById('app-modal');
    const msg = document.getElementById('app-modal-message');
    const ok = document.getElementById('app-modal-ok');

    let icon = '';
    if (type === 'success') {
      triggerHaptic('success');
      icon = '<i class="fas fa-check-circle" style="color:var(--ios-green);margin-right:8px"></i>';
    } else if (type === 'error') {
      triggerHaptic('error');
      icon = '<i class="fas fa-exclamation-triangle" style="color:var(--ios-red);margin-right:8px"></i>';
    } else {
      triggerHaptic('light');
      icon = '<i class="fas fa-info-circle" style="color:var(--accent);margin-right:8px"></i>';
    }

    msg.innerHTML = icon + (message || '');
    msg.className = type === 'success' ? 'status-approved' : (type === 'error' ? 'status-rejected' : '');

    const newOk = ok.cloneNode(true);
    ok.parentNode.replaceChild(newOk, ok);

    const closeHandler = () => {
      triggerHaptic('light');
      modal.style.display = 'none';
      if (typeof onClose === 'function') {
        try { onClose(); } catch (e) { console.error('Modal onClose error:', e); }
      }
    };

    newOk.addEventListener('click', closeHandler);

    const overlayHandler = (ev) => {
      if (ev.target === modal) closeHandler();
    };

    if (modal._overlayHandler) modal.removeEventListener('click', modal._overlayHandler);
    modal._overlayHandler = overlayHandler;
    modal.addEventListener('click', overlayHandler);

    modal.style.display = 'flex';
  }

  function showAppConfirm(message, cancelText = 'Cancel', okText = 'OK') {
    triggerHaptic('medium');
    return new Promise((resolve) => {
      let confirmEl = document.getElementById('app-confirm');
      if (!confirmEl) {
        confirmEl = document.createElement('div');
        confirmEl.id = 'app-confirm';
        confirmEl.className = 'modal';
        confirmEl.innerHTML = `
          <div class="modal-content card">
            <p id="app-confirm-message" style="margin-top:0;font-size:1.02rem;font-weight:600;line-height:1.4;"></p>
            <div style="margin-top:16px;display:flex;gap:10px;justify-content:flex-end">
              <button id="app-confirm-cancel" class="btn btn-secondary" style="width:auto;flex:1"></button>
              <button id="app-confirm-ok" class="btn btn-primary" style="width:auto;flex:1"></button>
            </div>
          </div>
        `;
        document.body.appendChild(confirmEl);
      }

      const msg = document.getElementById('app-confirm-message');
      const ok = document.getElementById('app-confirm-ok');
      const cancel = document.getElementById('app-confirm-cancel');

      cancel.textContent = cancelText;
      ok.textContent = okText;

      function cleanup(result) {
        triggerHaptic(result ? 'success' : 'light');
        confirmEl.style.display = 'none';
        ok.removeEventListener('click', onOk);
        cancel.removeEventListener('click', onCancel);
        confirmEl.removeEventListener('click', onOverlay);
        document.removeEventListener('keydown', onKeyDown);
        resolve(result);
      }

      function onKeyDown(ev) { if (ev && (ev.key === 'Escape' || ev.key === 'Esc')) cleanup(false); }
      document.addEventListener('keydown', onKeyDown);

      function onOk(ev) { ev && ev.preventDefault(); cleanup(true); }
      function onCancel(ev) { ev && ev.preventDefault(); cleanup(false); }
      function onOverlay(ev) { if (ev.target === confirmEl) cleanup(false); }

      ok.addEventListener('click', onOk);
      cancel.addEventListener('click', onCancel);
      confirmEl.addEventListener('click', onOverlay);

      msg.innerHTML = '<i class="fas fa-question-circle" style="color:var(--accent);margin-right:8px"></i>' + (message || '');
      confirmEl.style.display = 'flex';
    });
  }

  window.showAppModal = showAppModal;
  window.showAppConfirm = showAppConfirm;

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' || ev.key === 'Esc') {
      const m = document.getElementById('app-modal');
      if (m && m.style.display === 'flex') m.style.display = 'none';
    }
  });
})();

// --- 8. IMAGE MODAL FOR FULL-SIZE SELFIE VIEWING ---
(function () {
  function showImageModal(imageSrc, altText) {
    if (!imageSrc) return;
    triggerHaptic('light');

    let modal = document.getElementById('image-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'image-modal';
      modal.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;background:rgba(0,0,0,0.92);backdrop-filter:blur(10px);z-index:10000;display:none;align-items:center;justify-content:center;padding:20px;box-sizing:border-box;';
      modal.innerHTML = `
        <div style="position:relative;max-width:92%;max-height:92%;">
          <button id="close-image-modal" style="position:absolute;top:-46px;right:0;background:rgba(255,255,255,0.2);border:none;color:white;font-size:20px;border-radius:50%;width:36px;height:36px;cursor:pointer;display:flex;align-items:center;justify-content:center;">&times;</button>
          <img id="modal-image" style="max-width:100%;max-height:85vh;object-fit:contain;border-radius:18px;box-shadow:0 12px 40px rgba(0,0,0,0.5);">
        </div>
      `;
      document.body.appendChild(modal);

      document.getElementById('close-image-modal').addEventListener('click', () => {
        triggerHaptic('light');
        modal.style.display = 'none';
      });

      modal.addEventListener('click', (e) => {
        if (e.target === modal) {
          triggerHaptic('light');
          modal.style.display = 'none';
        }
      });

      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && modal.style.display === 'flex') {
          modal.style.display = 'none';
        }
      });
    }

    const img = document.getElementById('modal-image');
    img.src = imageSrc;
    img.alt = altText || 'Selfie Verification';
    modal.style.display = 'flex';
  }

  window.showImageModal = showImageModal;
})();

// --- 9. DEVICE DETECTION COOKIE ---
(function () {
  try {
    function detectMobile() {
      const ua = navigator.userAgent || '';
      const touch = ('ontouchstart' in window) || (navigator.maxTouchPoints && navigator.maxTouchPoints > 0);
      return /Mobi|Android|iPhone|iPad|Windows Phone/i.test(ua) || touch;
    }
    const isMobile = detectMobile() ? 'mobile' : 'desktop';
    document.cookie = `device_type=${encodeURIComponent(isMobile)}; path=/`;
  } catch (e) {}
})();

// --- 10. FLATPICKR INITIALIZATION ---
document.addEventListener('DOMContentLoaded', function () {
  if (typeof flatpickr !== 'undefined') {
    flatpickr("input[type=date]", {
      locale: { firstDayOfWeek: 1 },
      disableMobile: true,
      dateFormat: "Y-m-d",
      altInput: true,
      altFormat: "j-M-y",
      allowInput: true
    });
  }
});

// --- 11. BOTTOM NAVIGATION COMPONENT (iOS 18 Glass Bar) ---
function initBottomNav(currentPage, userRole) {
  const navItems = {
    owner: [
      { page: 'team', icon: 'fa-user-shield', href: '/team', title: 'Team' },
      { page: 'appsettings', icon: 'fa-cog', href: '/appsettings', title: 'Settings' },
      { page: 'visual', icon: 'fa-calendar-alt', href: '/visual', title: 'Calendar' },
      { page: 'profile', icon: 'fa-user-circle', href: '/profile', title: 'Profile' },
      { page: 'logout', icon: 'fa-sign-out-alt', href: '/logout', title: 'Logout' }
    ],
    manager: [
      { page: 'dashboard', icon: 'fa-home', href: '/dashboard', title: 'Home' },
      { page: 'team', icon: 'fa-user-shield', href: '/team', title: 'Team' },
      { page: 'visual', icon: 'fa-calendar-alt', href: '/visual', title: 'Calendar' },
      { page: 'profile', icon: 'fa-user-circle', href: '/profile', title: 'Profile' },
      { page: 'logout', icon: 'fa-sign-out-alt', href: '/logout', title: 'Logout' }
    ],
    employee: [
      { page: 'dashboard', icon: 'fa-home', href: '/dashboard', title: 'Home' },
      { page: 'visual', icon: 'fa-calendar-alt', href: '/visual', title: 'Calendar' },
      { page: 'profile', icon: 'fa-user-circle', href: '/profile', title: 'Profile' },
      { page: 'logout', icon: 'fa-sign-out-alt', href: '/logout', title: 'Logout' }
    ]
  };

  const items = navItems[userRole] || navItems.employee;

  const navHtml = `
    <nav class="bottom-nav">
      <div class="bottom-nav-container">
        ${items.map(item => `
          <a href="${item.href}" class="bottom-nav-item ${item.page === currentPage ? 'active' : ''}" title="${item.title}">
            <i class="fas ${item.icon}"></i>
            <span>${item.title}</span>
          </a>
        `).join('')}
      </div>
    </nav>
    <div class="bottom-spacer"></div>
  `;

  document.body.insertAdjacentHTML('beforeend', navHtml);
}

window.initBottomNav = initBottomNav;

// --- 12. BRANDING APPLICATION ---
async function applyBranding() {
  try {
    const res = await fetch('/branding');
    if (!res.ok) return;
    const branding = await res.json();

    if (branding.brandColor) {
      document.documentElement.style.setProperty('--brand-color', branding.brandColor);
      document.documentElement.style.setProperty('--accent', branding.brandColor);
      const r = parseInt(branding.brandColor.slice(1, 3), 16) || 14;
      const g = parseInt(branding.brandColor.slice(3, 5), 16) || 165;
      const b = parseInt(branding.brandColor.slice(5, 7), 16) || 164;
      document.documentElement.style.setProperty('--accent-rgb', `${r}, ${g}, ${b}`);
    }

    if (branding.companyName && document.title) {
      const currentTitle = document.title;
      if (!currentTitle.includes(branding.companyName)) {
        document.title = branding.companyName + ' - ' + currentTitle;
      }
    }
  } catch (e) {}
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', applyBranding);
} else {
  applyBranding();
}

window.applyBranding = applyBranding;

// --- 13. SERVICE WORKER ---
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
