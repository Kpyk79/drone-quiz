import { startPlayer } from './player.js';
import { startHost } from './host.js';
import { startScreen } from './screen.js';
import { startThermal } from './thermal.js';

const params = new URLSearchParams(location.search);
if (params.has('fly')) startThermal({ onExit: () => { location.href = location.pathname; } });
else if (params.has('host')) startHost();
else if (params.has('screen')) startScreen(params);
else startPlayer(params);
