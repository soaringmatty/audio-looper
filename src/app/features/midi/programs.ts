export const PROGRAMS =
  `Acoustic Grand Piano|Bright Piano|Electric Grand Piano|Honky-tonk|Electric Piano 1|Electric Piano 2|Harpsichord|Clavinet|Celesta|Glockenspiel|Music Box|Vibraphone|Marimba|Xylophone|Tubular Bells|Dulcimer|Drawbar Organ|Percussive Organ|Rock Organ|Church Organ|Reed Organ|Accordion|Harmonica|Tango Accordion|Nylon Guitar|Steel Guitar|Jazz Guitar|Clean Guitar|Muted Guitar|Overdriven Guitar|Distortion Guitar|Guitar Harmonics|Acoustic Bass|Finger Bass|Pick Bass|Fretless Bass|Slap Bass 1|Slap Bass 2|Synth Bass 1|Synth Bass 2|Violin|Viola|Cello|Contrabass|Tremolo Strings|Pizzicato Strings|Orchestral Harp|Timpani|String Ensemble 1|String Ensemble 2|Synth Strings 1|Synth Strings 2|Choir Aahs|Voice Oohs|Synth Voice|Orchestra Hit|Trumpet|Trombone|Tuba|Muted Trumpet|French Horn|Brass Section|Synth Brass 1|Synth Brass 2|Soprano Sax|Alto Sax|Tenor Sax|Baritone Sax|Oboe|English Horn|Bassoon|Clarinet|Piccolo|Flute|Recorder|Pan Flute|Blown Bottle|Shakuhachi|Whistle|Ocarina|Square Lead|Saw Lead|Calliope Lead|Chiff Lead|Charang Lead|Voice Lead|Fifths Lead|Bass + Lead|New Age Pad|Warm Pad|Polysynth Pad|Choir Pad|Bowed Pad|Metallic Pad|Halo Pad|Sweep Pad|Rain FX|Soundtrack FX|Crystal FX|Atmosphere FX|Brightness FX|Goblins FX|Echoes FX|Sci-fi FX|Sitar|Banjo|Shamisen|Koto|Kalimba|Bagpipe|Fiddle|Shanai|Tinkle Bell|Agogo|Steel Drums|Woodblock|Taiko Drum|Melodic Tom|Synth Drum|Reverse Cymbal|Guitar Fret Noise|Breath Noise|Seashore|Bird Tweet|Telephone|Helicopter|Applause|Gunshot`.split(
    '|',
  );

export const PROGRAM_GROUP_NAMES = [
  'Piano',
  'Chromatische Percussion',
  'Orgel & Akkordeon',
  'Gitarre',
  'Bass',
  'Streicher & Orchester',
  'Ensembles & Chor',
  'Blechbläser',
  'Holzbläser',
  'Flöten',
  'Synth Leads',
  'Synth Pads',
  'Synth-Effekte',
  'Weltinstrumente',
  'Percussion',
  'Geräusche & Effekte',
];

// 128 is a UI preset ID, never an on-wire MIDI program number.
export const STANDARD_DRUM_KIT = 128;
export const DEFAULT_PROGRAMS = [0, 0, 48, 40, STANDARD_DRUM_KIT];
export function isDrumProgram(program: number): boolean {
  return program === STANDARD_DRUM_KIT;
}
export function wireProgram(program: number): number {
  return isDrumProgram(program) ? 0 : program;
}
export function outputChannel(track: number, program: number): number {
  return isDrumProgram(program) ? 9 : track;
}
export function instrumentName(program: number): string {
  return (
    CLP625_VOICES.find((v) => v.id === program)?.name ??
    (isDrumProgram(program) ? 'Standard Drum Kit' : (PROGRAMS[program] ?? 'Instrument'))
  );
}
// Yamaha CLP-625 MIDI Reference p.5; program numbers on the wire are zero-based.
export const CLP625_VOICES = [
  { id: 256, name: 'CFX Grand', msb: 108, lsb: 0, program: 0 },
  { id: 257, name: 'Bösendorfer', msb: 108, lsb: 6, program: 0 },
  { id: 258, name: 'Pop Grand', msb: 108, lsb: 1, program: 1 },
  { id: 259, name: 'Stage E.Piano', msb: 108, lsb: 0, program: 4 },
  { id: 260, name: 'DX E.Piano', msb: 108, lsb: 0, program: 5 },
  { id: 261, name: 'Harpsichord', msb: 108, lsb: 0, program: 6 },
  { id: 262, name: 'Vibraphone', msb: 108, lsb: 0, program: 11 },
  { id: 263, name: 'Pipe Organ', msb: 108, lsb: 1, program: 19 },
  { id: 264, name: 'Jazz Organ', msb: 108, lsb: 0, program: 16 },
  { id: 265, name: 'Strings', msb: 108, lsb: 0, program: 48 },
];
export const DRUM_NAMES: Record<number, string> = {
  35: 'Acoustic Kick',
  36: 'Kick',
  37: 'Side Stick',
  38: 'Snare',
  39: 'Clap',
  40: 'Electric Snare',
  41: 'Low Tom',
  42: 'Closed Hi-Hat',
  43: 'Floor Tom',
  44: 'Pedal Hi-Hat',
  45: 'Tom',
  46: 'Open Hi-Hat',
  47: 'Mid Tom',
  48: 'High Tom',
  49: 'Crash',
  51: 'Ride',
};
