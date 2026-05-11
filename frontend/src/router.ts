import { createRouter, createWebHashHistory } from 'vue-router';
import DashboardView from './views/DashboardView.vue';
import DownloadsView from './views/DownloadsView.vue';
import NzbsView from './views/NzbsView.vue';
import WatchlistView from './views/WatchlistView.vue';

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/dashboard' },
    { path: '/dashboard', component: DashboardView },
    { path: '/watchlist', component: WatchlistView },
    { path: '/downloads', component: DownloadsView },
    { path: '/nzb', component: NzbsView },
    { path: '/:pathMatch(.*)*', redirect: '/dashboard' }
  ]
});
