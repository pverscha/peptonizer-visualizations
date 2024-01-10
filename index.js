import UnipeptVisualizations from "unipept-visualizations";
import puppeteer from "puppeteer";
import fs from "fs/promises";
import canvas from "canvas";
import { DOMParser } from 'xmldom'
import {
    Canvg,
    presets
} from 'canvg'
import crop from "crop-node";

if (process.argv.length !== 4) {
    console.error("Usage: node index.js <probabilities_file> <output_image_filename>");
    process.exit(1);
}

const file = process.argv[2];
const outputFile = process.argv[3];

const ncbiProbabilities = {};

let minimumProb = 100;
let maximumProb = 0;

// Read in CSV-file and process the probabilities in there.
const data = await fs.readFile(file, "utf-8");
for (const line of data.split("\n")) {
    const [taxonId, probability] = line.trimEnd().split(",");
    const prob = Math.round(parseFloat(probability) * 100);
    if (!isNaN(prob)) {
        minimumProb = Math.min(minimumProb, prob);
        maximumProb = Math.max(maximumProb, prob);
        ncbiProbabilities[taxonId] = prob;
    }
}

console.log("Minimum probability: " + minimumProb);
console.log("Maximum probability: " + maximumProb);

const sanitizeNode = function(n) {
    let maxOfChildren = n.data.self_count;

    for (const child of n.children || []) {
        sanitizeNode(child);
        maxOfChildren = Math.max(maxOfChildren, child.data.self_count);
    }

    n.data.self_count = maxOfChildren;
}

const sanitizeAgain = function(n) {
    for (const child of n.children || []){
        sanitizeAgain(child);
    }

    n.self_count = (n.data.self_count - minimumProb) / maximumProb;
    n.count = (n.data.self_count - minimumProb) / maximumProb;
}

const response = await fetch(
    "http://api.unipept.ugent.be/api/v1/taxa2tree.json",
    {
        method: "POST",
        mode: "cors",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            counts: ncbiProbabilities
        })
    }
);

const taxonomy = await response.json();
// console.log(JSON.stringify(taxonomy));
sanitizeNode(taxonomy);
sanitizeAgain(taxonomy);

console.log(JSON.stringify(taxonomy));


const browser = await puppeteer.launch({ headless: 'new' });
const page = await browser.newPage();

await page.setContent(
`
<html>
    <head>
        <script src="https://cdn.jsdelivr.net/npm/unipept-visualizations@2.1.2/dist/unipept-visualizations.js"></script>
    </head>
    <body>
        <div id="d3Treeview"></div>
    </body>
</html>
`
);

const originalWidth = 3000;
const originalHeight = 6000;

await page.exposeFunction("getTaxonomy", () => JSON.stringify(taxonomy));
await page.exposeFunction("getDimensions", () => JSON.stringify({
    width: originalWidth,
    height: originalHeight
}));

// Log data from the puppeteer browser
page.on('console', async (msg) => {
    const msgArgs = msg.args();
    for (let i = 0; i < msgArgs.length; ++i) {
        console.log(await msgArgs[i].jsonValue());
    }
});

const result = await page.evaluate(async () => {
    const element = document.getElementById("d3Treeview");
    const dimensions = JSON.parse(await getDimensions());

    const colorScale = ["#1F77B4", "#FF7F0E", "#2CA02C", "#D62728", "#9467BD", "#8C564B", "#E377C2", "#7F7F7F", "#BCBD22", "#17BECF"];
    let colorScaleStartIdx = 0;
    let previousLevel = -1;
    let colorScaleIdxLevel = 0;
    const colorProvider = (node, currentLevel) => {
        if (currentLevel < previousLevel) {
            colorScaleStartIdx = colorScaleIdxLevel;
            colorScaleIdxLevel = colorScaleStartIdx;
            return colorScale[colorScaleIdxLevel];
        } else if (currentLevel > previousLevel) {
            previousLevel = currentLevel;
            return colorScale[colorScaleIdxLevel];
        } else {
            previousLevel = currentLevel;
            return colorScale[colorScaleIdxLevel++];
        }
    }

    const nodeStrokeColorProvider = (node) => {
        return "#787878";
    }

    const treeview = new UnipeptVisualizations.Treeview(
        element,
        JSON.parse(await getTaxonomy()),
        {
            width: JSON.parse(dimensions.width),
            height: JSON.parse(dimensions.height),
            colorProviderLevels: 3,
            colorProvider: colorProvider,
            nodeStrokeColor: nodeStrokeColorProvider,
            minNodeSize: 2,
            maxNodeSize: 20,
            levelsToExpand: 30,
            animationDuration: 0
        }
    );

    await new Promise((resolve) => setTimeout(resolve, 1000));

    return element.innerHTML;
});

await browser.close();

const scaling = 3;

const preset = presets.node({
    DOMParser,
    canvas,
    fetch
});

const cv = preset.createCanvas(
    originalWidth * scaling,
    originalHeight * scaling
);

const svgString = result
    .replace(/width="[0-9]*%?"/, `width="${originalWidth * scaling}"`)
    .replace(/height="[0-9]*%?"/, `height="${originalHeight * scaling}"`)
    .replace(/viewBox="[^"]*"/, "")
    .replace("svg", `svg viewBox="0 0 ${originalWidth} ${originalHeight}"`);

const ctx = cv.getContext('2d')
const v = Canvg.fromString(ctx, svgString, preset);

await v.render();

const png = cv.toBuffer();

const cropped = await crop("data:image/png;base64," + png.toString("base64"), {
    outputFormat: "png"
});

await fs.writeFile(outputFile + ".png", cropped);
await fs.writeFile(outputFile + ".svg", result);
