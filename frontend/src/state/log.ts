import { ref } from 'vue';

export const logText = ref('');
export const logTitle = ref('');

export function openLog(title: string, text: string): void {
  logTitle.value = title;
  logText.value = text;
}

export function closeLog(): void {
  logTitle.value = '';
  logText.value = '';
}
