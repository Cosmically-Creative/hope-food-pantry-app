(function () {
  var form = document.querySelector('[data-settings]');
  if (!form) return;
  var far = form.querySelector('select[name="reminder_far"]');
  var near = form.querySelector('select[name="reminder_near"]');
  var months = form.querySelector('select[name="retention_months"]');
  var reminderPreview = form.querySelector('[data-reminder-preview]');
  var retentionPreview = form.querySelector('[data-retention-preview]');

  var phrase = function (select) {
    if (!select || select.selectedIndex < 0) return '';
    return select.options[select.selectedIndex].text.replace(' (usual)', '');
  };

  var clearError = function (select) {
    if (!select) return;
    var label = select.closest('label');
    var error = label && label.querySelector('.error');
    if (error) error.remove();
  };

  var paintReminders = function () {
    clearError(far);
    clearError(near);
    if (!far || !near || !reminderPreview) return;
    var first = phrase(far);
    var second = phrase(near);
    if (!first || !second) return;
    if (far.value === near.value) {
      reminderPreview.textContent = 'Choose two different times. One email should go out earlier than the other.';
      return;
    }
    var earlier = Number(far.value) >= Number(near.value) ? first : second;
    var closer = Number(far.value) >= Number(near.value) ? second : first;
    reminderPreview.textContent = 'Volunteers get an email ' + earlier + ' the shift, and another ' + closer + ' the shift.';
  };

  var paintRetention = function () {
    clearError(months);
    if (!months || !retentionPreview) return;
    var kept = phrase(months);
    if (!kept) return;
    retentionPreview.textContent = 'Names, email addresses, and phone numbers come off a signup ' + kept + ' after the shift ends.';
  };

  if (far) far.addEventListener('change', paintReminders);
  if (near) near.addEventListener('change', paintReminders);
  if (months) months.addEventListener('change', paintRetention);
})();
