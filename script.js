/* ============================================
   BOTTOR LEARNING FOUNDATION — Site JavaScript
   ============================================ */

/* ------------------------------------------------------------------
   🔧 CONFIGURATION — Update these values as needed
   ------------------------------------------------------------------ */

// ✅ GIVEBUTTER DONATION URL — Change this to your real Givebutter link
const GIVEBUTTER_URL = "https://givebutter.com/fund-a-new-way-to-teach-kids-reading-jpgwdh";

// ✅ CONTACT EMAIL — Change this to your real contact email
const CONTACT_EMAIL = "info@bottorlearningfoundation.org";

/* ------------------------------------------------------------------ */


// Apply Givebutter URL to all donate links on the page
function applyDonateLinks() {
  const donateLinks = document.querySelectorAll('a.donate-link, a.btn-donate');
  donateLinks.forEach(function(link) {
    link.setAttribute('href', GIVEBUTTER_URL);
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noopener noreferrer');
  });
}

// Mobile menu toggle
function setupMobileMenu() {
  const toggle = document.querySelector('.menu-toggle');
  const nav = document.querySelector('.nav-links');
  if (!toggle || !nav) return;

  toggle.addEventListener('click', function() {
    toggle.classList.toggle('active');
    nav.classList.toggle('open');
    const expanded = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', !expanded);
  });

  // Close menu when a link is clicked
  nav.querySelectorAll('a').forEach(function(link) {
    link.addEventListener('click', function() {
      toggle.classList.remove('active');
      nav.classList.remove('open');
      toggle.setAttribute('aria-expanded', 'false');
    });
  });
}

// Simple contact form handler (front-end only)
function setupContactForm() {
  const form = document.getElementById('contact-form');
  if (!form) return;

  form.addEventListener('submit', function(e) {
    e.preventDefault();
    var successMsg = document.getElementById('form-success');
    if (successMsg) {
      successMsg.style.display = 'block';
      form.reset();
      setTimeout(function() {
        successMsg.style.display = 'none';
      }, 5000);
    }
  });
}

// Set active navigation link based on current page
function setActiveNav() {
  var path = window.location.pathname.split('/').pop() || 'index.html';
  var links = document.querySelectorAll('.nav-links a:not(.nav-donate a)');
  links.forEach(function(link) {
    var href = link.getAttribute('href');
    if (href === path || (path === '' && href === 'index.html')) {
      link.classList.add('active');
    }
  });
}

// Initialize everything when DOM is ready
document.addEventListener('DOMContentLoaded', function() {
  applyDonateLinks();
  setupMobileMenu();
  setupContactForm();
  setActiveNav();
});
