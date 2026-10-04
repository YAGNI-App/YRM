// YRM dashboard: the only script. Pages work without it; it makes the time
// machine sliders move the date fields and travel when you let go.
(function () {
  "use strict";
  var DAY = 86400000;

  function addDays(start, n) {
    return new Date(Date.parse(start + "T00:00:00Z") + n * DAY).toISOString().slice(0, 10);
  }

  function daysFrom(start, date) {
    return Math.round((Date.parse(date + "T00:00:00Z") - Date.parse(start + "T00:00:00Z")) / DAY);
  }

  document.querySelectorAll("form[data-time-machine]").forEach(function (form) {
    form.querySelectorAll("input[type=range][data-target]").forEach(function (range) {
      var field = document.getElementById(range.getAttribute("data-target"));
      var start = range.getAttribute("data-start");
      if (!field || !start) return;
      range.addEventListener("input", function () {
        field.value = addDays(start, Number(range.value));
      });
      range.addEventListener("change", function () {
        form.requestSubmit ? form.requestSubmit() : form.submit();
      });
      field.addEventListener("change", function () {
        if (field.value) range.value = String(daysFrom(start, field.value));
        form.requestSubmit ? form.requestSubmit() : form.submit();
      });
    });
    // Empty date fields mean "now"; leave them out of the URL.
    form.addEventListener("submit", function () {
      form.querySelectorAll("input[type=date]").forEach(function (f) {
        if (!f.value) f.disabled = true;
      });
    });
  });

  // Opening a fact's provenance from a link (#fact-<id>) unfolds it.
  if (location.hash.indexOf("#fact-") === 0) {
    var target = document.getElementById(location.hash.slice(1));
    var details = target && target.querySelector("details.prov");
    if (details) details.open = true;
  }
})();
