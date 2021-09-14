'use strict'

import Vue from 'vue';

import { registerPluginLocalization } from '../../i18n';
import { registerRoute } from '../../routes';

import de from './i18n/de.js';
import en from './i18n/en.js';
import InputShaping from './InputShaping.vue';

import Algorithm from './Algorithm.vue';
import Chart from './Chart.vue';
import Recorder from './Recorder.vue';
import Session from './Session.vue';
import TestCommand from './TestCommand.vue';

Vue.component('algorithm', Algorithm);
Vue.component('chart', Chart);
Vue.component('recorder', Recorder);
Vue.component('session', Session);
Vue.component('test-command', TestCommand);

registerPluginLocalization('inputShaping', 'de', de);
registerPluginLocalization('inputShaping', 'en', en);

registerRoute(InputShaping, {
	Settings: {
		InputShaping: {
			icon: 'mdi-chart-timeline-variant',
			caption: 'plugins.inputShaping.menuCaption',
			path: '/InputShaping'
		}
	}
});

