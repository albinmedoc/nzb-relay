declare module '*.vue' {
  import type { DefineComponent } from 'vue';

  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}

interface Window {
  NZB_RELAY_CONFIG?: {
    backendUrl?: string;
    token?: string;
  };
}
