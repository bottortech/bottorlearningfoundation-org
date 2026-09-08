/* ============================================
   BOTTOR LEARNING FOUNDATION — Events Rendering
   ============================================
   Reusable renderer for the homepage "Upcoming Events"
   section and the Events & Calendar page (events.html).
   Reads its data from BLF_EVENTS (see events-data.js).
   ============================================ */

(function () {
  var STATUS_META = {
    pending: { label: "Pending Confirmation", className: "status-pending" },
    confirmed: { label: "Confirmed", className: "status-confirmed" }
  };

  var WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var MONTHS = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ];

  var calState = { year: 0, month: 0 };
  var lastFocusedEl = null;

  function pad(n) {
    return n < 10 ? "0" + n : "" + n;
  }

  function parseEventDate(ev) {
    var parts = ev.date.split("-").map(Number);
    return new Date(parts[0], parts[1] - 1, parts[2]);
  }

  function isoDate(d) {
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  function startOfToday() {
    var d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }

  function isPastEvent(ev) {
    return parseEventDate(ev) < startOfToday();
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  function to12Hour(t) {
    var bits = t.split(":");
    var h = parseInt(bits[0], 10);
    var period = h >= 12 ? "PM" : "AM";
    var h12 = h % 12;
    if (h12 === 0) h12 = 12;
    return h12 + ":" + bits[1] + " " + period;
  }

  function formatTimeRange(ev) {
    return to12Hour(ev.startTime) + " – " + to12Hour(ev.endTime);
  }

  function formatDateLong(ev) {
    return parseEventDate(ev).toLocaleDateString("en-US", {
      weekday: "long", year: "numeric", month: "long", day: "numeric"
    });
  }

  function formatDateShort(ev) {
    return parseEventDate(ev).toLocaleDateString("en-US", {
      month: "short", day: "numeric", year: "numeric"
    });
  }

  function sortedEvents() {
    return BLF_EVENTS.slice().sort(function (a, b) {
      return a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime);
    });
  }

  function getUpcoming() {
    return sortedEvents().filter(function (e) { return !isPastEvent(e); });
  }

  function getPast() {
    return sortedEvents().filter(isPastEvent).reverse();
  }

  function locationLine(ev) {
    return escapeHtml(ev.venue) + (ev.room ? " — " + escapeHtml(ev.room) : "");
  }

  /* ---------- Card markup ---------- */

  function eventCardHtml(ev) {
    var past = isPastEvent(ev);
    var status = STATUS_META[ev.status] || STATUS_META.pending;
    return (
      '<article class="event-card' + (past ? " is-past" : "") + '" data-event-id="' + ev.id + '" ' +
        'tabindex="0" role="button" aria-label="View details for ' + escapeHtml(ev.title) + '">' +
        '<div class="event-card-date">' +
          "<span>" + formatDateShort(ev) + "</span>" +
          (past ? '<span class="event-past-tag">Past Event</span>' : "") +
        "</div>" +
        '<div class="event-card-body">' +
          '<div class="event-badges">' +
            '<span class="event-status ' + status.className + '">' + status.label + "</span>" +
            (ev.cost ? '<span class="event-badge-muted">' + escapeHtml(ev.cost) + "</span>" : "") +
          "</div>" +
          "<h3>" + escapeHtml(ev.title) + "</h3>" +
          '<p class="event-meta">🕙 ' + formatTimeRange(ev) + "</p>" +
          '<p class="event-meta">📍 ' + locationLine(ev) + "</p>" +
          '<p class="event-desc">' + escapeHtml(ev.description) + "</p>" +
          '<span class="event-card-link">View Details →</span>' +
        "</div>" +
      "</article>"
    );
  }

  function renderGrid(containerId, events, emptyMessage) {
    var el = document.getElementById(containerId);
    if (!el) return;
    if (!events.length) {
      el.innerHTML = '<p class="event-empty">' + escapeHtml(emptyMessage) + "</p>";
      return;
    }
    el.innerHTML = events.map(eventCardHtml).join("");
  }

  /* ---------- Modal ---------- */

  function eventDetailHtml(ev) {
    var status = STATUS_META[ev.status] || STATUS_META.pending;
    var meta = [ev.cost, ev.audience].filter(Boolean).map(escapeHtml).join(" · ");
    return (
      (ev.image
        ? '<img class="event-modal-img" src="' + escapeHtml(ev.image) + '" alt="' + escapeHtml(ev.title) + '">'
        : "") +
      '<span class="event-status ' + status.className + '">' + status.label + "</span>" +
      '<h2 id="event-modal-title">' + escapeHtml(ev.title) + "</h2>" +
      '<p class="event-meta-lg">🗓️ ' + formatDateLong(ev) + "</p>" +
      '<p class="event-meta-lg">🕙 ' + formatTimeRange(ev) + "</p>" +
      '<p class="event-meta-lg">📍 ' + locationLine(ev) + (ev.address ? "<br>" + escapeHtml(ev.address) : "") + "</p>" +
      (meta ? '<p class="event-meta-lg">' + meta + "</p>" : "") +
      '<p class="event-modal-desc">' + escapeHtml(ev.description) + "</p>" +
      (ev.status === "pending"
        ? '<p class="event-pending-note">This event is pending confirmation from the venue. Details may change until it is marked Confirmed.</p>'
        : "")
    );
  }

  function eventDayListHtml(dateStr, events) {
    var label = parseEventDate(events[0]).toLocaleDateString("en-US", {
      weekday: "long", year: "numeric", month: "long", day: "numeric"
    });
    return (
      "<h2>" + escapeHtml(label) + "</h2>" +
      '<div class="event-day-list">' +
      events.map(function (ev) {
        var status = STATUS_META[ev.status] || STATUS_META.pending;
        return (
          '<button type="button" class="event-day-item" data-event-id="' + ev.id + '">' +
            "<strong>" + escapeHtml(ev.title) + "</strong>" +
            '<span class="event-meta">' + formatTimeRange(ev) + " · " + locationLine(ev) + "</span>" +
            '<span class="event-status ' + status.className + '">' + status.label + "</span>" +
          "</button>"
        );
      }).join("") +
      "</div>"
    );
  }

  function showModal(triggerEl) {
    var overlay = document.getElementById("event-modal-overlay");
    if (!overlay) return;
    lastFocusedEl = triggerEl || document.activeElement;
    overlay.hidden = false;
    document.body.style.overflow = "hidden";
    var closeBtn = overlay.querySelector(".event-modal-close");
    if (closeBtn) closeBtn.focus();
  }

  function closeModal() {
    var overlay = document.getElementById("event-modal-overlay");
    if (!overlay || overlay.hidden) return;
    overlay.hidden = true;
    document.body.style.overflow = "";
    if (lastFocusedEl && typeof lastFocusedEl.focus === "function") lastFocusedEl.focus();
  }

  function openModalForEvent(id, triggerEl) {
    var ev = BLF_EVENTS.filter(function (e) { return e.id === id; })[0];
    if (!ev) return;
    var body = document.getElementById("event-modal-body");
    if (!body) return;
    body.innerHTML = eventDetailHtml(ev);
    showModal(triggerEl);
  }

  function openModalForDate(dateStr, triggerEl) {
    var evs = sortedEvents().filter(function (e) { return e.date === dateStr; });
    if (!evs.length) return;
    if (evs.length === 1) {
      openModalForEvent(evs[0].id, triggerEl);
      return;
    }
    var body = document.getElementById("event-modal-body");
    if (!body) return;
    body.innerHTML = eventDayListHtml(dateStr, evs);
    showModal(triggerEl);
  }

  /* ---------- Calendar ---------- */

  function eventsByDate() {
    var map = {};
    sortedEvents().forEach(function (e) {
      (map[e.date] = map[e.date] || []).push(e);
    });
    return map;
  }

  function initCalendarState() {
    var upcoming = getUpcoming();
    var base = upcoming.length ? parseEventDate(upcoming[0]) : new Date();
    calState.year = base.getFullYear();
    calState.month = base.getMonth();
  }

  function renderCalendar() {
    var wrap = document.getElementById("events-calendar");
    if (!wrap) return;

    var year = calState.year, month = calState.month;
    var first = new Date(year, month, 1);
    var startOffset = first.getDay();
    var daysInMonth = new Date(year, month + 1, 0).getDate();
    var todayStr = isoDate(new Date());
    var byDate = eventsByDate();

    var html = '<div class="calendar-header">' +
      '<button type="button" class="calendar-nav-btn" id="cal-prev" aria-label="Previous month">&#8249;</button>' +
      '<span class="calendar-title">' + MONTHS[month] + " " + year + "</span>" +
      '<button type="button" class="calendar-nav-btn" id="cal-next" aria-label="Next month">&#8250;</button>' +
      "</div>" +
      '<div class="calendar-grid">';

    WEEKDAYS.forEach(function (w) {
      html += '<span class="calendar-weekday">' + w + "</span>";
    });

    for (var i = 0; i < startOffset; i++) {
      html += '<span class="calendar-day is-empty"></span>';
    }

    for (var day = 1; day <= daysInMonth; day++) {
      var iso = year + "-" + pad(month + 1) + "-" + pad(day);
      var dayEvents = byDate[iso];
      var classes = "calendar-day";
      if (dayEvents) classes += " has-event";
      if (iso === todayStr) classes += " is-today";
      if (dayEvents && new Date(year, month, day) < startOfToday()) classes += " is-past-day";

      if (dayEvents) {
        var title = dayEvents.map(function (e) { return e.title; }).join(", ");
        html += '<span class="' + classes + '" data-cal-date="' + iso + '" role="button" tabindex="0" ' +
          'aria-label="' + escapeHtml(title) + " on " + iso + '">' + day +
          '<span class="event-dot"></span></span>';
      } else {
        html += '<span class="' + classes + '">' + day + "</span>";
      }
    }

    html += "</div>";
    wrap.innerHTML = html;
  }

  function shiftMonth(delta) {
    calState.month += delta;
    if (calState.month < 0) { calState.month = 11; calState.year--; }
    if (calState.month > 11) { calState.month = 0; calState.year++; }
    renderCalendar();
  }

  /* ---------- Global interaction wiring (delegated, bound once) ---------- */

  function activate(target) {
    var eventTrigger = target.closest("[data-event-id]");
    if (eventTrigger) {
      openModalForEvent(eventTrigger.getAttribute("data-event-id"), eventTrigger);
      return true;
    }
    var dayTrigger = target.closest("[data-cal-date]");
    if (dayTrigger) {
      openModalForDate(dayTrigger.getAttribute("data-cal-date"), dayTrigger);
      return true;
    }
    if (target.closest("#cal-prev")) { shiftMonth(-1); return true; }
    if (target.closest("#cal-next")) { shiftMonth(1); return true; }
    if (target.closest(".event-modal-close")) { closeModal(); return true; }
    if (target.id === "event-modal-overlay") { closeModal(); return true; }
    return false;
  }

  function setupEventInteractions() {
    document.addEventListener("click", function (e) {
      activate(e.target);
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { closeModal(); return; }
      if (e.key !== "Enter" && e.key !== " ") return;
      var actionable = e.target.closest("[data-event-id], [data-cal-date], #cal-prev, #cal-next");
      if (actionable) {
        e.preventDefault();
        activate(e.target);
      }
    });
  }

  /* ---------- Init ---------- */

  document.addEventListener("DOMContentLoaded", function () {
    if (typeof BLF_EVENTS === "undefined") return;

    renderGrid("home-upcoming-events", getUpcoming().slice(0, 3),
      "No upcoming events right now — check back soon!");

    renderGrid("events-upcoming-grid", getUpcoming(),
      "No upcoming events right now — check back soon! Follow our socials or contact us for updates.");

    var pastGrid = document.getElementById("events-past-grid");
    var pastSection = document.getElementById("events-past-section");
    if (pastGrid && pastSection) {
      var past = getPast();
      pastSection.hidden = past.length === 0;
      if (past.length) renderGrid("events-past-grid", past, "");
    }

    if (document.getElementById("events-calendar")) {
      initCalendarState();
      renderCalendar();
    }

    setupEventInteractions();
  });
})();
