import ReactDatePicker, { registerLocale } from 'react-datepicker';
import 'react-datepicker/dist/react-datepicker.css';
import { ru } from 'date-fns/locale/ru';
import type { ReactElement } from 'react';

registerLocale('ru', ru);

interface DatePickerProps {
  value: string;
  onChange: (iso: string | undefined) => void;
  placeholder?: string;
  maxDate?: Date;
  minDate?: Date;
}

/**
 * Thin wrapper around `react-datepicker` that speaks in YYYY-MM-DD strings
 * (matching the existing filter contract) and applies the project's input class.
 * Uses the Russian locale: Cyrillic month names, week starts on Monday.
 */
export function DatePicker({
  value,
  onChange,
  placeholder,
  maxDate,
  minDate,
}: DatePickerProps): ReactElement {
  const selected = value ? new Date(`${value}T12:00:00`) : null;

  const handleChange = (date: Date | null): void => {
    if (date === null) {
      onChange(undefined);
      return;
    }
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    onChange(`${y}-${m}-${d}`);
  };

  return (
    <ReactDatePicker
      selected={selected}
      onChange={handleChange}
      locale="ru"
      dateFormat="dd.MM.yyyy"
      placeholderText={placeholder ?? ''}
      className="input"
      calendarClassName="datepicker-calendar"
      isClearable
      showMonthDropdown
      showYearDropdown
      dropdownMode="scroll"
      maxDate={maxDate}
      minDate={minDate}
    />
  );
}
