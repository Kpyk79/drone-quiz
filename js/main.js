import { startPlayer } from './player.js';
import { startHost } from './host.js';
import { startScreen } from './screen.js';

const params = new URLSearchParams(location.search);
if (params.has('host')) startHost();
else if (params.has('screen')) startScreen(params);
else startPlayer(params);
