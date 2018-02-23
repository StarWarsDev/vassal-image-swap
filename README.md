# Vassal Card Swap

[![Codacy Badge](https://api.codacy.com/project/badge/Grade/3c048436560d43b59321fc7f46320695)](https://app.codacy.com/app/sgood/vassal-image-swap?utm_source=github.com&utm_medium=referral&utm_content=StarWarsDev/vassal-image-swap&utm_campaign=badger)

An easy to use utility script that generates a new X-Wing Miniatures Vassal Module (vmod) file with full text card images.

## Cards replaced

- Pilots
- Upgrades
- Conditions
- Damage Deck (Core)
- Damage Deck (TFA)

## Usage

### Prerequisites
- [Git](https://git-scm.com/)
- [Yarn](https://yarnpkg.com/en/) or [NPM](https://www.npmjs.com/get-npm)
- [Node.js](https://nodejs.org/en/)

### Download the project

`git clone https://github.com/StarWarsDev/vassal-image-swap.git && cd vassal-image-swap`

### Install package dependencies

Yarn: `yarn`

**or**

NPM: `npm i`

### Run the script

Yarn: `yarn swap`

**or**

NPM: `npm run swap`

### Install in Vassal

A vmod file will be produced and found in the `tmp` folder within the project.
Move it to another location and [install normally](http://xwvassal.info/guide#installNav).
