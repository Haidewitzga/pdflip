/** Goodnotes versions PDFlip has been tested with. */
export const testedWith = 'Goodnotes 5 (version 7.1.27) on iPad'

/** GitHub repository that receives problem reports. */
export const repo = 'Haidewitzga/pdflip'

/**
 * Address of the problem-report relay (the Cloudflare Worker in relay/), e.g.
 * 'https://pdflip-reports.<account>.workers.dev'. Empty: the report button opens a pre-filled
 * GitHub issue page instead. The build also allows this address in the Content Security Policy.
 */
export const reportUrl: string = ''
