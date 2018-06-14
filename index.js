import _ from 'lodash'
import archiver from 'archiver'
import fs from 'fs'
import Git from 'nodegit'
import Jimp from 'jimp'
import { stdout } from 'single-line-log'
import path from 'path'
import request from 'request'
import progress from 'request-progress'
import ProgressBar from 'progress'
import rimraf from 'rimraf'
import unzipper from 'unzipper'

import condition_mappings from './condition-mappings.json'
import damage_deck_core_mappings from './damage-deck-core-mappings.json'
import pilot_mappings from './pilot-mappings.json'
import upgrade_mappings from './upgrade-mappings.json'
import ignored from './ignored.json'

/*
 * Card patterns:
 * - Pilot : Pilot(-|_)({pilot_name}.jpg
 * - Upgrade : Up-{upgrade_name}.jpg
 * - Condition: Cond-{condition_name}.jpg
 * - Damage : Hit-{crit_name}.png
 */
const vmod_version = '8.0.0'
const vmod_filename = `Star_Wars_X-Wing_Miniatures_Game-${vmod_version}.vmod`

const create_tmp_dir = (tmp_dir) => {
  const dir = path.join(__dirname, tmp_dir)
  console.log(`Creating temp directory at ${dir}`)
  fs.mkdirSync(dir)
}

const remove_xwing_tmp_dir = dir => new Promise(resolve => {
  rimraf(dir, () => {
    console.log(`Removed ${dir}`)
    resolve()
  })
})

const remove_vmod_dir = vmod_dir_path => new Promise(resolve => {
  rimraf(vmod_dir_path, () => {
    console.log(`Removed ${vmod_dir_path}`)
    resolve()
  })
})

const clone_xwing_data = async (xwing_tmp_dir) => {
  console.log(`Cloning xwing-data repo in ${xwing_tmp_dir}`)
  const xwing_data_url = 'https://github.com/guidokessels/xwing-data.git'
  return await Git.Clone(xwing_data_url, xwing_tmp_dir)
}

const download_vassal_module = tmp_dir => new Promise((resolve, reject) => {
  const vmod_download_url = `https://github.com/Mu0n/XWVassal/releases/download/${vmod_version}/Star_Wars_X-Wing_Miniatures_Game-${vmod_version}.vmod`
  const filename = vmod_filename
  const download_path = path.join(__dirname, tmp_dir)

  stdout(`Downloading ${filename} to ${download_path}\n`)

  progress(request(vmod_download_url))
    .on('progress', state => {
      let msg = `Downloading ${filename}: ${Math.floor(state.percent * 100)}%`
      if (state.time.remaining) {
        msg += `  ::  ${Math.floor(state.time.remaining)}s remaining  ::  ${Math.floor(state.speed / 1000)}/kbps`
      }
      stdout(`${msg}\n`)
    })
    .on('end', () => {
      stdout.clear()
      resolve(path.join(download_path, filename))
    })
    .pipe(fs.createWriteStream(path.join(download_path, filename)))
})

const unzip_vmod = (tmp_dir, vmod_file_path) => new Promise(resolve => {
  const vmod_filename = path.basename(vmod_file_path, '.vmod')
  const extract_path = path.join(tmp_dir, vmod_filename)

  fs.mkdirSync(extract_path)

  console.log(`Unzipping ${vmod_file_path} to ${extract_path}`)

  fs.createReadStream(vmod_file_path)
    .pipe(unzipper.Extract({ path: extract_path }))
    .on('close', () => resolve(extract_path))
})

const match_pilot_images = async (vmod_pilot_image_files, xwing_data_path) => {
  const xwing_data_pilot_data = JSON.parse(fs.readFileSync(path.join(xwing_data_path, 'data', 'pilots.js'), 'utf8'))
  let images_to_copy = []
  let unmatched_files = []
  let skipped_files = []

  vmod_pilot_image_files.forEach( file => {
    const skip = ignored.filter(name => name === file).length === 1
    if (skip) {
      // console.log('Skipping', file)
      skipped_files.push(file)
    } else {
      // console.log('Attempting to match', file, 'to a pilot...')
      const mapping = pilot_mappings[file]
      if (mapping) {
        const pilot = _.find(xwing_data_pilot_data, {id: mapping})
        if (pilot) {
          // console.log('Matched pilot, ', pilot.name)

          images_to_copy.push({
            vmod: { image: file },
            xwing_data: { image: pilot.image }
          })
        }
      } else {
        const name = file
          .replace(/Pilot([-_])/, '')
          .replace('.jpg', '')
          .replace(/_/g, ' ')
          .replace(/ Sq /, ' Squadron ')
          .replace(/-/, ' ')

        let pilot = _.find(xwing_data_pilot_data, {name})

        if (!pilot) {
          const foundPilots = xwing_data_pilot_data.filter(p => {
            const p_name = p.name.toLowerCase()
            const file_name = `"${name.toLowerCase()}"`
            return p_name === file_name
          })

          if (foundPilots && foundPilots.length === 1) {
            pilot = foundPilots[0]
          }
        }

        if (pilot) {
          // console.log('Matched pilot, ', pilot.name)
          images_to_copy.push({
            vmod: { image: file },
            xwing_data: { image: pilot.image }
          })
        } else {
          unmatched_files.push({file, name})
        }
      }
    }
  })

  console.log('\n--------------- PILOT CARD IMAGES ---------------')
  console.log(`${vmod_pilot_image_files.length} pilot images in vmod file`)
  console.log(`${skipped_files.length} skipped pilot card images`)
  console.log(`${unmatched_files.length} unmatched pilot card images`)
  console.log(`${images_to_copy.length} pilot card images matched`)

  return images_to_copy
}

const remove_file = async file_path => new Promise((resolve, reject) => {
  rimraf(file_path, () => resolve(), () => reject())
})

const replace_image_with = async (old_image, new_image, width, height) => {
  await remove_file(old_image)
  const pilot_image = await Jimp.read(new_image)

  if (width && height) {
    pilot_image.resize(width, height)
  }

  pilot_image.quality(100)
  pilot_image.write(old_image)
}

const replace_images = async (images_to_copy, vmod_dir_path, xwing_data_path, width, height) => {
  const progressBar = new ProgressBar(':image [:percent]', { total: images_to_copy.length + 1 })
  await Promise.all(images_to_copy.map(async image_data => {
    const vmod_image_file = image_data.vmod.image
    const vmod_image = path.join(vmod_dir_path, 'images', vmod_image_file)
    const xwd_image = path.join(xwing_data_path, 'images', image_data.xwing_data.image)

    await replace_image_with(vmod_image, xwd_image, width, height)
    progressBar.tick({
      image: `Swapping ${vmod_image_file}`
    })
  }))

  progressBar.tick({
    image: 'Swap complete'
  })
}

const replace_pilot_images = async (vmod_dir_path, xwing_data_path) => {
  const vmod_images_path = path.join(vmod_dir_path, 'images')
  const vmod_pilot_image_files = fs.readdirSync(vmod_images_path).filter(file => file.startsWith('Pilot'))
  const images_to_copy = await match_pilot_images(vmod_pilot_image_files, xwing_data_path)
  await replace_images(images_to_copy, vmod_dir_path, xwing_data_path)
}

const match_condition_images = async (vmod_condition_image_files, xwing_data_path) => {
  const xwing_data_condition_data = JSON.parse(fs.readFileSync(path.join(xwing_data_path, 'data', 'conditions.js'), 'utf8'))
  let images_to_copy = []
  let unmatched_files = []
  let skipped_files = []

  vmod_condition_image_files.forEach( file => {
    const skip = ignored.filter(name => name === file).length === 1
    if (skip) {
      // console.log('Skipping', file)
      skipped_files.push(file)
    } else {
      // console.log('Attempting to match', file, 'to a condition')
      const mapping = condition_mappings[file]

      if (mapping !== undefined) {
        let condition = _.find(xwing_data_condition_data, { id: mapping })

        if (condition) {
          // console.log('Matched condition', condition.name)
          images_to_copy.push({
            vmod: { image: file },
            xwing_data: { image: condition.image }
          })
        }
      } else {
        const xws = file
          .replace('Condition_', '')
          .replace('.jpg', '')

        let condition = _.find(xwing_data_condition_data, { xws })

        if (condition) {
          // console.log('Matched condition', condition.name)
          images_to_copy.push({
            vmod: { image: file },
            xwing_data: { image: condition.image }
          })
        } else {
          unmatched_files.push({ file, xws })
        }
      }
    }
  })

  console.log('\n--------------- CONDITION CARD IMAGES ---------------')
  console.log(`${vmod_condition_image_files.length} condition images in vmod file`)
  console.log(`${skipped_files.length} skipped condition card images`)
  console.log(`${unmatched_files.length} unmatched condition card images`)
  console.log(`${images_to_copy.length} condition card images matched`)

  return images_to_copy
}

const replace_condition_card_images = async (vmod_dir_path, xwing_data_path) => {
  const vmod_images_path = path.join(vmod_dir_path, 'images')
  const vmod_condition_image_files = fs.readdirSync(vmod_images_path).filter(file => (
    file.startsWith('Condition_') && file.endsWith('.jpg')
  ))

  const images_to_copy = await match_condition_images(vmod_condition_image_files, xwing_data_path)
  await replace_images(images_to_copy, vmod_dir_path, xwing_data_path)
}

const match_crit_card_images = async (image_files, xwing_data_path) => {
  const damage_deck_core = JSON.parse(fs.readFileSync(path.join(xwing_data_path, 'data', 'damage-deck-core.js'), 'utf8'))
  const damage_deck_tfa = JSON.parse(fs.readFileSync(path.join(xwing_data_path, 'data', 'damage-deck-core-tfa.js'), 'utf8'))

  // this just covers the core and tfa damage decks

  let images_to_copy = []
  let unmatched_files = []
  let skipped_files = []

  image_files.forEach( file => {
    const skip = ignored.filter(name => name === file).length === 1
    if (skip) {
      // console.log('Skipping', file)
      skipped_files.push(file)
    } else {
      // console.log('Attempting to match', file, 'to a crit card')
      const is_revised = file.endsWith('_revised.png')
      let name = file
        .replace('Hit-', '')
        .replace('.png', '')
        .replace(/_/g, ' ')

      if (is_revised) {
        name = name.replace('revised', '').trim()
        // console.log('Looking up', name, 'from The Force Awakens damage deck')
        const card = _.find(damage_deck_tfa, { name })

        if (card) {
          images_to_copy.push({
            vmod: { image: file },
            xwing_data: { image: card.image }
          })
        } else {
          unmatched_files.push({ file, name })
        }

      } else {
        // console.log('Looking up', name, 'from the core damage deck')

        const mapping = damage_deck_core_mappings[file]

        if (mapping) {
          name = mapping
        }

        let card = _.find(damage_deck_core, { name })

        if (card) {
          images_to_copy.push({
            vmod: { image: file },
            xwing_data: { image: card.image }
          })
        } else if (card = _.find(damage_deck_tfa, { name })) {
          images_to_copy.push({
            vmod: { image: file },
            xwing_data: { image: card.image }
          })
        } else {
          unmatched_files.push({ file, name })
        }
      }

    }
  })

  console.log('\n--------------- CRIT CARD IMAGES ---------------')
  console.log(`${image_files.length} crit card images in vmod file`)
  console.log(`${ skipped_files.length} skipped crit card images`)
  console.log(`${unmatched_files.length} 'unmatched crit card images`)
  console.log(`${ images_to_copy.length} crit card images matched`)

  return images_to_copy
}

const replace_crit_card_images = async (vmod_dir_path, xwing_data_path) => {
  const vmod_images_path = path.join(vmod_dir_path, 'images')
  const vmod_image_files = fs.readdirSync(vmod_images_path).filter( file => file.startsWith('Hit-'))
  const images_to_copy = await match_crit_card_images(vmod_image_files, xwing_data_path)
  await replace_images(images_to_copy, vmod_dir_path, xwing_data_path, 108, 162)
}

const match_upgrade_card_images = async (image_files, xwing_data_path) => {
  const xwing_data_upgrade_data = JSON.parse(fs.readFileSync(path.join(xwing_data_path, 'data', 'upgrades.js'), 'utf8'))
  let images_to_copy = []
  let unmatched_files = []
  let skipped_files = []

  image_files.forEach( file => {
    const skip = ignored.filter(name => name === file).length === 1
    const endsWithBack = file.endsWith('_back.jpg')
    const isMapped = upgrade_mappings[file] !== undefined
    if (!isMapped && (skip || endsWithBack)) {
      // console.log('Skipping', file)
      skipped_files.push(file)
    } else {
      // console.log('Attempting to match', file, 'to an upgrade')
      const mapping = upgrade_mappings[file]

      if (mapping !== undefined) {
        let upgrade = _.find(xwing_data_upgrade_data, { id: mapping })

        if (upgrade) {
          // console.log('Matched upgrade', upgrade.name)
          images_to_copy.push({
            vmod: { image: file },
            xwing_data: { image: upgrade.image }
          })
        }
      } else {
        let xws = file
          .replace('Upgrade_', '')
          .replace(/(Astromech|Bomb|Cannon|Cargo|Crew|Elite|Hardpoint|Illicit|Missile|Modification|SalvagedAstromech|System|Team|Tech|Title|Torpedo|Turret)_/, '')
          .replace(/_/g, ' ')
          .replace('.jpg', '')

        let upgrade = _.find(xwing_data_upgrade_data, { xws })

        if (!upgrade) {
          const foundUpgrades = xwing_data_upgrade_data.filter(u => {
            const u_xws = u.xws.toLowerCase()
            const file_xws = xws.toLowerCase()
            return u_xws === file_xws
          })

          if (foundUpgrades && foundUpgrades.length === 1) {
            upgrade = foundUpgrades[0]
          }
        }

        if (upgrade) {
          // console.log('Matched upgrade', upgrade.name)
          images_to_copy.push({
            vmod: { image: file },
            xwing_data: { image: upgrade.image }
          })
        } else {
          unmatched_files.push({ file, xws })
        }
      }
    }
  })

  console.log('\n--------------- UPGRADE CARD IMAGES ---------------')
  console.log(`${image_files.length} upgrade card images in vmod file`)
  console.log(`${skipped_files.length} skipped upgrade card images`)
  console.log(`${unmatched_files.length} unmatched upgrade card images`)
  console.log(`${images_to_copy.length} upgrade card images matched`)

  return images_to_copy
}

const replace_upgrade_card_images = async (vmod_dir_path, xwing_data_path) => {
  const vmod_images_path = path.join(vmod_dir_path, 'images')
  const vmod_image_files = fs.readdirSync(vmod_images_path).filter( file => file.startsWith('Upgrade_'))
  const images_to_copy = await match_upgrade_card_images(vmod_image_files, xwing_data_path)
  await replace_images(images_to_copy, vmod_dir_path, xwing_data_path)
}

const create_vmod_file = (tmp_path, vmod_tmp_path) => new Promise((resolve, reject) => {
  const vmod_output_path = path.join(__dirname, tmp_path, vmod_filename)
  const output = fs.createWriteStream(vmod_output_path)
  const archive = archiver('zip')

  output.on('close', () => {
    console.log(`\nNew vmod file has been generated @ ${vmod_output_path}`)
    resolve()
  })

  archive.on('error', err => {
    reject(err)
  })

  archive.pipe(output)
  archive.directory(vmod_tmp_path, false)

  archive.finalize()
})

{
  // This goes last to kick off the process
  const tmp_dir = './tmp'
  const xwing_data_dir = './xwing-data'

  rimraf(tmp_dir, async () => {
    create_tmp_dir(tmp_dir)

    const xwing_tmp_dir = path.join(__dirname, tmp_dir, xwing_data_dir)
    rimraf(xwing_tmp_dir, async () => {
      await clone_xwing_data(xwing_tmp_dir)

      const module_file_path = await download_vassal_module(tmp_dir)
      console.log(`Vassal module saved to: ${module_file_path}`)

      const vmod_dir_path = await unzip_vmod(path.join(__dirname, tmp_dir), module_file_path)

      // replace pilot cards
      await replace_pilot_images(vmod_dir_path, xwing_tmp_dir)

      // replace condition cards
      await replace_condition_card_images(vmod_dir_path, xwing_tmp_dir)

      // replace crit cards
      await replace_crit_card_images(vmod_dir_path, xwing_tmp_dir)

      // replace upgrade cards
      await replace_upgrade_card_images(vmod_dir_path, xwing_tmp_dir)

      // remove old vmod file
      await remove_file(path.join(__dirname, tmp_dir, vmod_filename))

      // compress new vmod file
      await create_vmod_file(tmp_dir, vmod_dir_path)


      console.log('Cleaning up...')
      await remove_xwing_tmp_dir(xwing_tmp_dir)
      await remove_vmod_dir(vmod_dir_path)
    })
  })
}
