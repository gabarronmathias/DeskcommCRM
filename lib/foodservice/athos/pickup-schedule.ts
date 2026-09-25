export interface PickupSchedule {
  scheduledAtLocal: string;
  timezone: string;
}

export type PickupScheduleResult =
  | { kind: 'none' }
  | { kind: 'incomplete'; message: string }
  | { kind: 'scheduled'; value: PickupSchedule };

/** Only an explicit pickup instruction (or its follow-up) changes an order. */
export function parsePickupSchedule(
  text: string,
  now: Date,
  timezone: string,
  pickupAlreadySelected = false,
): PickupScheduleResult {
  const pickupMentioned = /\bretir(?:ar|ada|o|amos|arei|a)\b/iu.test(text);
  const dateMentioned = /\bamanh[aã](?!\p{L})|\bhoje\b|\b\d{1,2}\/\d{1,2}(?:\/\d{4})?\b/iu.test(text);
  const timeMatch = text.match(/(?:^|[\s,(])(?:às|as|pelas?)\s*(\d{1,2})(?:[h:](\d{2}))?\s*h?(?!\d)|\b(\d{1,2})h(\d{2})?\b/iu);
  if (!pickupMentioned && !(pickupAlreadySelected && (dateMentioned || timeMatch))) {
    return { kind: 'none' };
  }
  if (!dateMentioned || !timeMatch) {
    return { kind: 'incomplete', message: 'Para a retirada, informe o dia e o horário (por exemplo, amanhã às 10h).' };
  }

  const hour = Number(timeMatch[1] ?? timeMatch[3]);
  const minute = Number(timeMatch[2] ?? timeMatch[4] ?? '0');
  if (hour > 23 || minute > 59) {
    return { kind: 'incomplete', message: 'Esse horário não é válido. Informe o dia e a hora da retirada novamente.' };
  }

  const currentParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const part = (name: string) => Number(currentParts.find((item) => item.type === name)?.value);
  const today = new Date(Date.UTC(part('year'), part('month') - 1, part('day')));
  let target = today;
  if (/\bamanh[aã](?!\p{L})/iu.test(text)) {
    target = new Date(today.getTime() + 86_400_000);
  } else {
    const explicit = text.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\b/u);
    if (explicit) {
      const year = explicit[3] ? Number(explicit[3]) : part('year');
      const month = Number(explicit[2]);
      const day = Number(explicit[1]);
      target = new Date(Date.UTC(year, month - 1, day));
      if (target.getUTCFullYear() !== year || target.getUTCMonth() !== month - 1 || target.getUTCDate() !== day) {
        return { kind: 'incomplete', message: 'Essa data não é válida. Informe o dia e a hora da retirada novamente.' };
      }
    }
  }
  const targetTime = Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate(), hour, minute);
  const currentTime = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'));
  if (targetTime <= currentTime) {
    return { kind: 'incomplete', message: 'Essa data ou horário já passou. Informe um horário futuro para a retirada.' };
  }
  const two = (value: number) => String(value).padStart(2, '0');
  return {
    kind: 'scheduled',
    value: {
      scheduledAtLocal: `${target.getUTCFullYear()}-${two(target.getUTCMonth() + 1)}-${two(target.getUTCDate())}T${two(hour)}:${two(minute)}:00`,
      timezone,
    },
  };
}
