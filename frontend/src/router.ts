import { createRouter, createWebHashHistory } from 'vue-router';
import DashboardView from './views/DashboardView.vue';
import DownloadsView from './views/DownloadsView.vue';
import MoviesView from './views/MoviesView.vue';
import NzbsView from './views/NzbsView.vue';
import WatchlistSourceView from './views/WatchlistSourceView.vue';
import WatchlistView from './views/WatchlistView.vue';

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/dashboard' },
    { path: '/dashboard', component: DashboardView },
    { path: '/movies', component: MoviesView },
    { path: '/watchlist', component: WatchlistView },
    { path: '/watchlist/:sourceId', component: WatchlistSourceView },
    { path: '/downloads', component: DownloadsView },
    { path: '/nzb', component: NzbsView },
    { path: '/:pathMatch(.*)*', redirect: '/dashboard' }
  ]
});
