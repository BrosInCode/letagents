export const avatarColors = [
 {id:'sage',name:'Sage',shell:'#83b49b',pale:'#b5d8c0',joint:'#305247',rubber:'#213c34',trim:'#416b59',glass:'#0e2723',light:'#d6ffe4',emissive:'#9af2bd'},
 {id:'blue',name:'Glacier',shell:'#7dabc8',pale:'#bed9e8',joint:'#304958',rubber:'#202f3b',trim:'#42677e',glass:'#10202d',light:'#e0f6ff',emissive:'#a2dcfa'},
 {id:'lilac',name:'Lilac',shell:'#a494c5',pale:'#d4c7e7',joint:'#493b60',rubber:'#30283f',trim:'#685681',glass:'#21192f',light:'#f0e6ff',emissive:'#cfaff9'},
 {id:'rose',name:'Rose',shell:'#c58e9c',pale:'#e7c4cb',joint:'#60404b',rubber:'#3c2830',trim:'#815662',glass:'#2e1923',light:'#ffe9ef',emissive:'#f9b7c9'},
 {id:'amber',name:'Honey',shell:'#c5a165',pale:'#e9d5aa',joint:'#605034',rubber:'#3c3123',trim:'#816a43',glass:'#2b2317',light:'#fff2cf',emissive:'#f9d18d'},
 {id:'graphite',name:'Graphite',shell:'#636974',pale:'#a8afb7',joint:'#30343c',rubber:'#1e2229',trim:'#414853',glass:'#10151d',light:'#e2f4ff',emissive:'#c0d9ed'},
 {id:'pearl',name:'Pearl',shell:'#d1cdc5',pale:'#f1ece2',joint:'#555651',rubber:'#31332f',trim:'#8a8b80',glass:'#202720',light:'#f6ffe9',emissive:'#d7edbd'}
];
export const characterNames: Record<string, string> = {"orbit": "Orbit", "prism": "Prism", "tide": "Tide", "spark": "Scout", "bloom": "Milo", "beacon": "Nova", "fern": "Fern", "pip": "Pip", "pebble": "Pebble", "moss": "Moss", "wren": "Wren", "ember": "Ember", "cosmo": "Cosmo", "nimbus": "Nimbus", "comet": "Comet", "lune": "Lune", "ripple": "Ripple", "vesper": "Vesper"};
export const avatarFinish = (id: string) => avatarColors.find(color => color.id === id) ?? avatarColors[0];
export type AvatarFinish = typeof avatarColors[number];
