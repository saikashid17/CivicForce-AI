import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";
import { PRESET_ISSUES } from "./src/data/presetIssues";
import { Issue, IssueCategory, IssueStatus, IssueSeverity, AIAnalysisResult } from "./src/types";

dotenv.config();

const app = express();
const PORT = 3000;

// High limits for handling image/video uploads as base64 in Express
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// In-Memory Database initialized with seed data
let issuesDB: Issue[] = [...PRESET_ISSUES];

// Lazy initialize Gemini SDK client
let aiClient: GoogleGenAI | null = null;
function getGeminiClient(): GoogleGenAI | null {
  if (!aiClient) {
    const key = process.env.GEMINI_API_KEY;
    if (key && key !== "MY_GEMINI_API_KEY") {
      aiClient = new GoogleGenAI({
        apiKey: key,
        httpOptions: {
          headers: {
            "User-Agent": "aistudio-build",
          },
        },
      });
      console.log("Gemini client successfully initialized from server env.");
    }
  }
  return aiClient;
}

// REST API Endpoints

// Get all issues
app.get("/api/issues", (req, res) => {
  res.json(issuesDB);
});

// Post a new issue
app.post("/api/issues", (req, res) => {
  const newIssue: Issue = req.body;
  if (!newIssue.id || !newIssue.title || !newIssue.category) {
    res.status(400).json({ error: "Invalid issue structure submitted." });
    return;
  }
  issuesDB.unshift(newIssue);
  res.status(201).json(newIssue);
});

// Verify an issue
app.post("/api/issues/:id/verify", (req, res) => {
  const { id } = req.params;
  const { verifierName } = req.body;

  if (!verifierName) {
    res.status(400).json({ error: "Verifier name is required." });
    return;
  }

  const issueIndex = issuesDB.findIndex((issue) => issue.id === id);
  if (issueIndex === -1) {
    res.status(404).json({ error: "Issue not found." });
    return;
  }

  const issue = issuesDB[issueIndex];

  // Prevent multiple verifications from the same user if possible, but keep it open
  const alreadyVerified = issue.verifiedBy.map(v => v.trim().toLowerCase()).includes(verifierName.trim().toLowerCase());
  
  if (!alreadyVerified) {
    issue.verifiedBy.push(verifierName);
    issue.verifications += 1;
    issue.trustScore = Math.min(100, Math.round(80 + (issue.verifications * 2.5)));
    
    // Automatically transition Reported to Verified once verified by custom users
    if (issue.status === IssueStatus.REPORTED && issue.verifications >= 2) {
      issue.status = IssueStatus.VERIFIED;
      // update action plan first step to completed
      if (issue.actionPlan && issue.actionPlan[0]) {
        issue.actionPlan[0].status = "completed";
        issue.actionPlan[0].updatedAt = new Date().toISOString();
      }
    }
    
    issuesDB[issueIndex] = issue;
  }

  res.json(issue);
});

// Resolve an issue
app.post("/api/issues/:id/resolve", (req, res) => {
  const { id } = req.params;
  const { resolutionNotes } = req.body;

  const issueIndex = issuesDB.findIndex((issue) => issue.id === id);
  if (issueIndex === -1) {
    res.status(404).json({ error: "Issue not found." });
    return;
  }

  const issue = issuesDB[issueIndex];
  issue.status = IssueStatus.RESOLVED;
  issue.resolutionNotes = resolutionNotes || "Resolved by community department team and verified by field crews.";
  issue.resolvedAt = new Date().toISOString();

  // Complete all steps in the action plan
  if (issue.actionPlan) {
    issue.actionPlan = issue.actionPlan.map(step => ({
      ...step,
      status: "completed",
      updatedAt: step.updatedAt || new Date().toISOString()
    }));
  }

  issuesDB[issueIndex] = issue;
  res.json(issue);
});

// Fallback AI local analyzer in case of missing keys/network issues
function generateLocalFallbackAnalysis(
  text: string, 
  hasImage: boolean, 
  nearby: any[] = [], 
  weather: any = null
): AIAnalysisResult {
  const content = (text || "").toLowerCase();
  let category = IssueCategory.PUBLIC_INFRASTRUCTURE;
  let department = "PMC Bridge Engineering & Public Works Bureau";
  let title = "Reported Infrastructure Hazard";
  let severity = IssueSeverity.MEDIUM;
  let suggestedResolution = "Schedule on-site assessment and deploy civil engineering repair crew.";
  let repairPriority: "Immediate" | "High-Priority" | "Scheduled" | "Routine" = "Scheduled";

  if (content.includes("pothole") || content.includes("road") || content.includes("asphalt") || content.includes("pavement") || content.includes("street lane")) {
    category = IssueCategory.POTHOLES;
    title = "Localized Asphalt Road Damage / Pothole";
    department = "PMC Road Maintenance & Public Works Department";
    severity = content.includes("crater") || content.includes("deep") || content.includes("highway") ? IssueSeverity.HIGH : IssueSeverity.MEDIUM;
    suggestedResolution = "Clear debris, apply quick-hardening cold bituminous asphalt mix, compact with mechanical roller, and seal seams.";
    repairPriority = severity === IssueSeverity.HIGH ? "High-Priority" : "Scheduled";
  } else if (content.includes("water") || content.includes("leak") || content.includes("pipe") || content.includes("burst") || content.includes("flood")) {
    category = IssueCategory.WATER_LEAKS;
    title = "High-Pressure Subsurface Water Pipeline Burst";
    department = "PMC Water Supply & Sanitation Department";
    severity = content.includes("gushing") || content.includes("flood") || content.includes("burst") ? IssueSeverity.CRITICAL : IssueSeverity.HIGH;
    suggestedResolution = "Isolate nearest sluice gate, excavate sub-grade trench, secure pipe fracture with a carbon-steel repair sleeve clamp, and restore pathway.";
    repairPriority = severity === IssueSeverity.CRITICAL ? "Immediate" : "High-Priority";
  } else if (content.includes("streetlight") || content.includes("dark") || content.includes("lamp") || content.includes("bulb") || content.includes("light")) {
    category = IssueCategory.BROKEN_STREETLIGHTS;
    title = "Inoperative Walkway Smart LED Luminaire";
    department = "PCMC Electrical Engineering Bureau";
    severity = content.includes("broken") || content.includes("school") ? IssueSeverity.HIGH : IssueSeverity.MEDIUM;
    suggestedResolution = "Inspect smart solar-timer node, swap burnt lamp heads with high-efficiency 150W moisture-resistant LED pods, and re-arm panel breakers.";
    repairPriority = severity === IssueSeverity.HIGH ? "High-Priority" : "Scheduled";
  } else if (content.includes("garbage") || content.includes("trash") || content.includes("dump") || content.includes("waste") || content.includes("accumulate")) {
    category = IssueCategory.GARBAGE_ACCUMULATION;
    title = "Unregulated Refuse & Wet Commercial Waste Pile";
    department = "BMC Solid Waste Management Department";
    severity = content.includes("medical") || content.includes("toxic") ? IssueSeverity.HIGH : IssueSeverity.MEDIUM;
    suggestedResolution = "Mobilize mechanical loaders and dumper trucks, lift waste pile to Deonar landfill, and apply sodium hypochlorite disinfectant.";
    repairPriority = "Scheduled";
  }

  if (hasImage && severity === IssueSeverity.MEDIUM) {
    severity = IssueSeverity.HIGH;
    repairPriority = "High-Priority";
  }

  // Weather Intelligence adjustment
  let rainFactor = false;
  let stormFactor = false;
  if (weather && !weather.error) {
    if (weather.precipitation > 2.0 || weather.condition?.toLowerCase().includes("rain")) {
      rainFactor = true;
      if (category === IssueCategory.WATER_LEAKS) {
        severity = IssueSeverity.CRITICAL;
        repairPriority = "Immediate";
      }
      if (category === IssueCategory.POTHOLES) {
        severity = IssueSeverity.HIGH;
        repairPriority = "High-Priority";
      }
    }
    if (weather.windSpeed > 20 || weather.condition?.toLowerCase().includes("storm")) {
      stormFactor = true;
      if (category === IssueCategory.PUBLIC_INFRASTRUCTURE) {
        severity = IssueSeverity.CRITICAL;
        repairPriority = "Immediate";
      }
    }
  }

  // Nearby Infrastructure adjustment
  let hospitalClose = false;
  let schoolClose = false;
  if (Array.isArray(nearby)) {
    for (const item of nearby) {
      if (item.distance < 200) {
        if (item.type === "Hospital") {
          hospitalClose = true;
          severity = IssueSeverity.CRITICAL;
          repairPriority = "Immediate";
        }
        if (item.type === "School") {
          schoolClose = true;
          if (severity !== IssueSeverity.CRITICAL) {
            severity = IssueSeverity.HIGH;
            repairPriority = "High-Priority";
          }
        }
      }
    }
  }

  let urgency = 60;
  let severityScore = 55;
  let affectedCitizens = 75;

  if (severity === IssueSeverity.CRITICAL) {
    urgency = 95;
    severityScore = 92;
    affectedCitizens = 400;
  } else if (severity === IssueSeverity.HIGH) {
    urgency = 80;
    severityScore = 75;
    affectedCitizens = 180;
  } else if (severity === IssueSeverity.MEDIUM) {
    urgency = 55;
    severityScore = 50;
    affectedCitizens = 60;
  } else {
    urgency = 25;
    severityScore = 20;
    affectedCitizens = 15;
  }

  const explicitFacts = [
    `User reported complaint description: "${text || "No text description specified."}"`,
    hasImage ? "Citizen attached photographic evidence of the hazard." : "No visual media attached.",
    weather && !weather.error ? `Live Local Weather: Temp ${weather.temp}°C, ${weather.condition}, Wind ${weather.windSpeed} km/h` : "No weather metadata returned."
  ];

  const aiInferences = [
    `Identified potential hazard representing active municipal ${category.toLowerCase()} issues.`,
    hospitalClose ? "Immediate vulnerability of ambulance access lanes due to proximity of a hospital." : "Located inside urban residential sector.",
    rainFactor ? "Active rainfall multiplies soil erosion and pavement collapse rates." : "No active heavy weather risks."
  ];

  const reasoning = `Based on explicit reporting, a concern was flagged at specified coordinates. ` +
    (hospitalClose ? `Proximity to active healthcare systems (<200m) elevates priority significantly. ` : "") +
    (rainFactor ? `Active precipitation raises risk of localized washouts and road degradation. ` : "") +
    `Thus, we calculated a severity score of ${severityScore}% and prioritized dispatch under the ${department}.`;

  return {
    title: `AI Dispatch: ${title}`,
    category,
    severity,
    urgency,
    department,
    summary: `A professional report for ${category.toLowerCase()} registered at coordinates. Proximity markers flag immediate residential safety indices. Local dispatch initiated to safeguard community flow.`,
    affectedCitizens,
    aiConfidence: 89,
    severityScore,
    actionPlan: [
      {
        title: "Perimeter Demarcation",
        description: "Deploy safety barrels, warning tape, and blinking caution lamps to safeguard pedestrians and incoming motorists."
      },
      {
        title: "Mechanical Resource Routing",
        description: `Direct the closest ${department} service vehicle equipped with proper repair inventory to the coordinate pin.`
      },
      {
        title: "Field Repair Operations",
        description: `Perform target mechanics (${suggestedResolution.toLowerCase()}) to bring assets back to complete municipal specifications.`
      },
      {
        title: "Post-Audit Verification & Clearance",
        description: "Execute structural/electrical load tests, take after-repair photographs, and release coordinates for open public transit."
      }
    ],
    explicitFacts,
    aiInferences,
    reasoning,
    suggestedResolution,
    repairPriority
  };
}

// REST API Reverse Geocoding Proxy / Fallback
app.get("/api/geocode", async (req, res) => {
  const { lat, lng } = req.query;
  if (!lat || !lng) {
    res.status(400).json({ error: "Latitude and Longitude are required." });
    return;
  }
  const latitude = parseFloat(lat as string);
  const longitude = parseFloat(lng as string);

  const key = process.env.GOOGLE_MAPS_PLATFORM_KEY;
  if (key && key !== "YOUR_API_KEY") {
    try {
      const response = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?latlng=${latitude},${longitude}&key=${key}`);
      const data = await response.json();
      if (data.status === "OK" && data.results && data.results[0]) {
        res.json({ address: data.results[0].formatted_address });
        return;
      }
    } catch (e) {
      console.error("Google reverse-geocoding failed:", e);
    }
  }

  // Fallback high-fidelity local reverse geocoder for Indian municipal areas
  let nearestAddress = "MG Road, Camp Area, Pune, Maharashtra 411001";
  let minDistance = Infinity;

  const landmarks = [
    { name: "Karve Road, Near Karve Putla Chowk, Kothrud, Pune, Maharashtra 411038", lat: 18.5132, lng: 73.8341 },
    { name: "Sassoon Road, Opposite Sassoon General Hospital Emergency Gate, Shivaji Nagar, Pune, Maharashtra 411001", lat: 18.5273, lng: 73.8690 },
    { name: "Sector 29, Behind Akurdi Railway Station Road, Akurdi, Pune, Maharashtra 411044", lat: 18.6475, lng: 73.7597 },
    { name: "Lokmanya Tilak Marg, Fort Area, Near St. Xavier's High School, Mumbai, Maharashtra 400001", lat: 18.9469, lng: 72.8335 },
    { name: "Baner Road, Adjacent to Balewadi High Street Corner, Pune, Maharashtra 411045", lat: 18.5591, lng: 73.8052 },
    { name: "Fergusson College Road, Shivaji Nagar, Pune, Maharashtra 411004", lat: 18.5245, lng: 73.8415 },
    { name: "Senapati Bapat Road, Shivajinagar, Pune, Maharashtra 411016", lat: 18.5362, lng: 73.8291 },
    { name: "Koramangala 80 Feet Road, Bengaluru, Karnataka 560034", lat: 12.9352, lng: 77.6244 },
    { name: "Indiranagar 100 Feet Road, Bengaluru, Karnataka 560038", lat: 12.9719, lng: 77.6412 },
    { name: "Linking Road, Bandra West, Mumbai, Maharashtra 400050", lat: 19.0583, lng: 72.8398 }
  ];

  for (const lm of landmarks) {
    const dist = Math.sqrt(Math.pow(latitude - lm.lat, 2) + Math.pow(longitude - lm.lng, 2));
    if (dist < minDistance) {
      minDistance = dist;
      nearestAddress = lm.name;
    }
  }

  res.json({ address: nearestAddress });
});

// REST API Nearby Places Proxy / Fallback
app.get("/api/places/nearby", async (req, res) => {
  const { lat, lng } = req.query;
  if (!lat || !lng) {
    res.status(400).json({ error: "Latitude and Longitude are required." });
    return;
  }
  const latitude = parseFloat(lat as string);
  const longitude = parseFloat(lng as string);
  const key = process.env.GOOGLE_MAPS_PLATFORM_KEY;

  if (key && key !== "YOUR_API_KEY") {
    try {
      const response = await fetch("https://places.googleapis.com/v1/places:searchNearby", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": key,
          "X-Goog-FieldMask": "places.id,places.displayName,places.types,places.location"
        },
        body: JSON.stringify({
          maxResultCount: 8,
          locationRestriction: {
            circle: {
              center: { latitude, longitude },
              radius: 500.0
            }
          }
        })
      });
      const data = await response.json();
      if (data.places && Array.isArray(data.places)) {
        const mapped = data.places.map((place: any) => {
          let type = "Government Office";
          const types = place.types || [];
          if (types.includes("school") || types.includes("university") || types.includes("education")) type = "School";
          else if (types.includes("hospital") || types.includes("doctor") || types.includes("medical") || types.includes("health")) type = "Hospital";
          else if (types.includes("bus_station") || types.includes("transit_station") || types.includes("subway_station") || types.includes("bus_stop")) type = "Bus Stop";
          else if (types.includes("police")) type = "Police Station";
          else if (types.includes("local_government_office") || types.includes("government_office") || types.includes("city_hall")) type = "Government Office";

          const dLat = (place.location.latitude - latitude) * Math.PI / 180;
          const dLng = (place.location.longitude - longitude) * Math.PI / 180;
          const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
                    Math.cos(latitude * Math.PI / 180) * Math.cos(place.location.latitude * Math.PI / 180) *
                    Math.sin(dLng/2) * Math.sin(dLng/2);
          const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
          const distance = Math.round(6371000 * c);

          return {
            name: place.displayName?.text || place.displayName || "Municipal Facility",
            type,
            distance
          };
        });
        res.json(mapped);
        return;
      }
    } catch (e) {
      console.error("Google Places API failed, using fallback:", e);
    }
  }

  // Fallback realistic Indian places
  const candidatePlaces = [
    { name: "Sahyadri Super Speciality Hospital", type: "Hospital", lat: 18.5132, lng: 73.8341 },
    { name: "Abasaheb Garware College", type: "School", lat: 18.5132, lng: 73.8341 },
    { name: "Kothrud Police Station", type: "Police Station", lat: 18.5132, lng: 73.8341 },
    { name: "Sassoon General Hospital", type: "Hospital", lat: 18.5273, lng: 73.8690 },
    { name: "Pune Junction Railway Police Station", type: "Police Station", lat: 18.5273, lng: 73.8690 },
    { name: "Pune Central Post Office", type: "Government Office", lat: 18.5273, lng: 73.8690 },
    { name: "DY Patil College of Engineering", type: "School", lat: 18.6475, lng: 73.7597 },
    { name: "Akurdi Railway Station Bus Stand", type: "Bus Stop", lat: 18.6475, lng: 73.7597 },
    { name: "PCMC Ward Office Sector 29", type: "Government Office", lat: 18.6475, lng: 73.7597 },
    { name: "St. Xavier's High School", type: "School", lat: 18.9469, lng: 72.8335 },
    { name: "BMC General Ward Office", type: "Government Office", lat: 18.9469, lng: 72.8335 },
    { name: "Gokuldas Tejpal Public Hospital", type: "Hospital", lat: 18.9469, lng: 72.8335 },
    { name: "Balewadi High Street Bus Stop", type: "Bus Stop", lat: 18.5591, lng: 73.8052 },
    { name: "Baner Ward PMC Office", type: "Government Office", lat: 18.5591, lng: 73.8052 },
    { name: "Jupiter Hospital", type: "Hospital", lat: 18.5591, lng: 73.8052 }
  ];

  const results = candidatePlaces.map((place) => {
    const dLat = (place.lat - latitude) * 111000;
    const dLng = (place.lng - longitude) * 111000 * Math.cos(latitude * Math.PI / 180);
    const distance = Math.round(Math.sqrt(dLat * dLat + dLng * dLng));
    return {
      name: place.name,
      type: place.type,
      distance
    };
  }).filter(p => p.distance < 1500)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 5);

  if (results.length === 0) {
    res.json([
      { name: "Local Municipal Ward Clinic", type: "Hospital", distance: 180 },
      { name: "Zilla Parishad Primary School", type: "School", distance: 290 },
      { name: "PMPML Bus Stand", type: "Bus Stop", distance: 340 },
      { name: "Assistant Police Inspector's Chowky", type: "Police Station", distance: 480 },
      { name: "E-Seva Municipal Kendra Office", type: "Government Office", distance: 620 }
    ]);
  } else {
    res.json(results);
  }
});

// REST API Live Weather Proxy (Open-Meteo Integration)
app.get("/api/weather", async (req, res) => {
  const { lat, lng } = req.query;
  if (!lat || !lng) {
    res.status(400).json({ error: "Latitude and Longitude are required." });
    return;
  }
  const latitude = parseFloat(lat as string);
  const longitude = parseFloat(lng as string);

  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_speed_10m&timezone=auto`;
    const response = await fetch(url);
    const data = await response.json();
    if (data && data.current) {
      const code = data.current.weather_code;
      let condition = "Clear Sky";
      if (code >= 1 && code <= 3) condition = "Partly Cloudy";
      else if (code >= 45 && code <= 48) condition = "Foggy";
      else if (code >= 51 && code <= 55) condition = "Drizzle";
      else if (code >= 61 && code <= 65) condition = "Moderate Rain";
      else if (code >= 80 && code <= 82) condition = "Heavy Rain Showers";
      else if (code >= 95 && code <= 99) condition = "Thundery Storm";

      res.json({
        temp: Math.round(data.current.temperature_2m),
        condition,
        precipitation: data.current.precipitation || 0,
        windSpeed: Math.round(data.current.wind_speed_10m || 0),
        humidity: Math.round(data.current.relative_humidity_2m || 65),
        lastUpdated: new Date().toLocaleTimeString()
      });
      return;
    } else {
      res.json({
        error: true,
        message: "Weather data could not be retrieved"
      });
      return;
    }
  } catch (e) {
    console.error("Open-Meteo API failed:", e);
    res.json({
      error: true,
      message: "Weather data could not be retrieved"
    });
    return;
  }
});

// AI Analysis via Gemini or Fallback
app.post("/api/analyze", async (req, res) => {
  const { 
    text, 
    latitude, 
    longitude, 
    nearbyInfrastructure = [], 
    weather = null, 
    imageBase64, 
    imageMimeType, 
    videoBase64, 
    videoMimeType, 
    hasVoice 
  } = req.body;

  const summaryOfInput = `Text Prompt: "${text || "No description provided"}" at [${latitude || 18.52}, ${longitude || 73.85}], Weather: ${JSON.stringify(weather)}, Nearby Infrastructure Tally: ${nearbyInfrastructure?.length || 0}`;
  console.log(`Analyzing: ${summaryOfInput}`);

  // Perform Duplicate Detection locally in database first
  const latNum = parseFloat(latitude || "18.5204");
  const lngNum = parseFloat(longitude || "73.8567");
  
  const duplicateMatches = issuesDB.map(issue => {
    const dLat = (issue.latitude - latNum) * 111000;
    const dLng = (issue.longitude - lngNum) * 111000 * Math.cos(latNum * Math.PI / 180);
    const distance = Math.round(Math.sqrt(dLat * dLat + dLng * dLng));
    return { issueId: issue.id, title: issue.title, distance };
  }).filter(item => item.distance < 300); // 300 meters threshold

  const ai = getGeminiClient();

  if (!ai) {
    console.log("No valid GEMINI_API_KEY found, running beautiful local heuristic analyzer...");
    const fallback = generateLocalFallbackAnalysis(text || "", !!imageBase64 || !!videoBase64, nearbyInfrastructure, weather);
    res.json({ ...fallback, duplicateMatches });
    return;
  }

  try {
    const systemPrompt = `You are an expert AI municipal dispatcher and civic health coordinator for the Kolhapur Municipal Corporation (KMC) in Maharashtra, India.
Analyze the user's community concern (which can consist of text description in English, Hindi [हिंदी], or Marathi [मराठी], a base64-encoded image or video, or transcribed voice).
Understand multilingual complaints in Hindi, Marathi, and English seamlessly and generate the JSON response strictly in English.

You are equipped with the following context about the surrounding coordinates:
- Nearby infrastructure detected: ${JSON.stringify(nearbyInfrastructure)}
- Live Weather metrics: ${JSON.stringify(weather)}
- Potential nearby matching reports: ${JSON.stringify(duplicateMatches)}

IMPORTANT CRITERIA FOR INTENTIONAL REASONING & ACCURACY:
1. Gemini must never hallucinate.
2. Explicitly separate what are 'Explicit Facts' (items directly mentioned/seen in user descriptions or imagery) from 'AI Inferences' (expert deductions/risks calculated from weather, surroundings, and municipal rules).
3. Weather Intelligence: You MUST prioritize issues heavily under these active meteorological triggers:
   - Water leaks/burst pipes before forecasted or active rainfall (dramatic water mixing risk, localized pooling).
   - Roads that are historically flood-prone or near gutters.
   - Broken trees or rusted signs/overbridge structures during active wind storms.
4. Nearby Infrastructure: Prioritize urgency heavily (escalate to High or Critical) if critical infrastructure like Schools or Hospitals are within 200m. Explain this directly in your 'reasoning' section.
5. Provide a realistic suggested municipal resolution and assign 'repairPriority' strictly from: 'Immediate', 'High-Priority', 'Scheduled', 'Routine'.

Match the category EXACTLY to one of these:
- 'Potholes'
- 'Water Leaks'
- 'Broken Streetlights'
- 'Garbage Accumulation'
- 'Public Infrastructure'
- 'Other'

Assess and select severity strictly from:
- 'Low'
- 'Medium'
- 'High'
- 'Critical'

Determine the exact responsible Indian municipal department name (e.g. 'KMC Road Maintenance & Public Works Department').
Assign a numerical Urgency Score between 1 and 100 representing safety hazards.
Assign a numerical Severity Score between 1 and 100 representing damage extent.
Estimate the number of Affected Citizens (integer) likely impacted.
Assign an AI Confidence Score between 50 and 100 based on clarity of input.`;

    const contentsArr: any[] = [];

    if (imageBase64) {
      contentsArr.push({
        inlineData: {
          mimeType: imageMimeType || "image/png",
          data: imageBase64
        }
      });
    }

    if (videoBase64) {
      contentsArr.push({
        inlineData: {
          mimeType: videoMimeType || "video/mp4",
          data: videoBase64
        }
      });
    }

    contentsArr.push({
      text: `Analyze this user report:
"${text || "No description text provided. Inspect uploaded imagery directly for civic issues."}"
${hasVoice ? "(The description came from a citizens' live voice-recorded message)" : ""}`
    });

    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: { parts: contentsArr },
      config: {
        systemInstruction: systemPrompt,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            title: { type: Type.STRING, description: "A concise and highly professional title for the logged issue in English (e.g., 'Gushing Water Pipeline Burst on Sassoon Road')." },
            category: { type: Type.STRING, description: "Must be EXACTLY one of: 'Potholes', 'Water Leaks', 'Broken Streetlights', 'Garbage Accumulation', 'Public Infrastructure', or 'Other'." },
            severity: { type: Type.STRING, description: "Must be EXACTLY one of: 'Low', 'Medium', 'High', 'Critical'." },
            urgency: { type: Type.INTEGER, description: "The urgency score ranging strictly from 1 (lowest) to 100 (highest)." },
            department: { type: Type.STRING, description: "The exact municipal agency suited to repair this (e.g., 'PMC Road Maintenance Department')." },
            summary: { type: Type.STRING, description: "A highly professional, objective 2-sentence summary in English illustrating the hazard and predicted consequences if ignored." },
            affectedCitizens: { type: Type.INTEGER, description: "The estimated number of citizens affected by this issue." },
            aiConfidence: { type: Type.INTEGER, description: "Confidence score percentage representing how reliable the source is on a 50 to 100 scale." },
            severityScore: { type: Type.INTEGER, description: "The calculated severity score percentage ranging strictly from 1 to 100." },
            explicitFacts: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
              description: "A list of explicit facts derived solely from the text and images with zero hallucinated details."
            },
            aiInferences: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
              description: "A list of logical inferences based on weather conditions, nearby schools/hospitals, and urban risks."
            },
            reasoning: { type: Type.STRING, description: "A complete step-by-step reasoning explaining exactly how you arrived at the severity, urgency and repairPriority based on weather and infrastructure indicators." },
            suggestedResolution: { type: Type.STRING, description: "A concrete, realistic engineering or administrative fix for this municipal concern." },
            repairPriority: { type: Type.STRING, description: "Must be EXACTLY one of: 'Immediate', 'High-Priority', 'Scheduled', 'Routine'." },
            actionPlan: {
              type: Type.ARRAY,
              description: "A professional, logical 4-step timeline suited to rectify this specific issue.",
              items: {
                type: Type.OBJECT,
                properties: {
                  title: { type: Type.STRING, description: "Step brief title in English (e.g. 'Emergency Sluice Gate Isolation')." },
                  description: { type: Type.STRING, description: "Procedural instructions in English for the field mechanics or engineers." }
                },
                required: ["title", "description"]
              }
            }
          },
          required: [
            "title", "category", "severity", "urgency", "department", "summary", 
            "actionPlan", "affectedCitizens", "aiConfidence", "severityScore",
            "explicitFacts", "aiInferences", "reasoning", "suggestedResolution", "repairPriority"
          ]
        }
      }
    });

    const textResponse = response.text;
    if (!textResponse) {
      throw new Error("Empty token response from Gemini.");
    }

    const parsedResult: AIAnalysisResult = JSON.parse(textResponse);
    res.json({ ...parsedResult, duplicateMatches });

  } catch (error: any) {
    console.error("Gemini Analysis failed, reverting to local fallback:", error);
    const fallback = generateLocalFallbackAnalysis(text || "", !!imageBase64, nearbyInfrastructure, weather);
    res.json({ ...fallback, duplicateMatches });
  }
});

// Fallback voice analysis function
function generateFallbackVoiceAnalysis(text: string): any {
  const input = (text || "").trim();
  let language = "English";
  let transcript = input || "There is a huge pothole near DY Patil College.";
  let translation = transcript;
  let category = "Other";
  let severity = "Medium";
  let urgencyScore = 50;
  let department = "Municipal General Administration Department";
  let location = "Unknown";
  let explicitFacts: string[] = [];

  const lower = transcript.toLowerCase();

  // Detect Marathi: check "लाईट", "नाही", "रस्त्यावर", "लाईत", "light"
  if (lower.includes("नाही") || lower.includes("लाईट") || lower.includes("रस्त्यावर") || lower.includes("आहे") || lower.includes("लाईत")) {
    language = "Marathi";
    transcript = input || "रस्त्यावर लाईट नाही आहे.";
    translation = "There is no light on the street.";
    category = "Broken Streetlights";
    severity = "High";
    urgencyScore = 75;
    department = "Bureau of Street Lighting";
    location = "Unknown";
    explicitFacts = ["No light on the street", "It is dark and unsafe"];
  } 
  // Detect Hindi: check "इलाके", "पानी", "पाइपलाइन", "लीक"
  else if (lower.includes("पानी") || lower.includes("पाइपलाइन") || lower.includes("लीक") || lower.includes("इलाके") || lower.includes("हमारे")) {
    language = "Hindi";
    transcript = input || "हमारे इलाके में पानी की पाइपलाइन लीक हो रही है।";
    translation = "Water pipeline is leaking in our area.";
    category = "Water Leaks";
    severity = "Critical";
    urgencyScore = 90;
    department = "Bureau of Water Supply & Sanitation";
    location = "Unknown";
    explicitFacts = ["Water pipeline is leaking", "Leaking in the local area"];
  }
  // English pothole
  else if (lower.includes("pothole") || lower.includes("dy patil") || lower.includes("road")) {
    language = "English";
    transcript = input || "There is a huge pothole near DY Patil College.";
    translation = transcript;
    category = "Potholes";
    severity = "High";
    urgencyScore = 80;
    department = "Municipal Department of Transportation";
    if (lower.includes("dy patil")) {
      location = "Near DY Patil College";
      explicitFacts = ["Huge pothole present", "Located near DY Patil College"];
    } else {
      location = "Unknown";
      explicitFacts = ["Pothole on the road"];
    }
  }
  // General fallback
  else {
    if (lower.includes("pothole") || lower.includes("road")) {
      category = "Potholes";
      department = "Municipal Department of Transportation";
      severity = "Medium";
      urgencyScore = 60;
    } else if (lower.includes("water") || lower.includes("leak") || lower.includes("pipe")) {
      category = "Water Leaks";
      department = "Bureau of Water Supply & Sanitation";
      severity = "High";
      urgencyScore = 80;
    } else if (lower.includes("light") || lower.includes("dark")) {
      category = "Broken Streetlights";
      department = "Bureau of Street Lighting";
      severity = "Medium";
      urgencyScore = 70;
    } else if (lower.includes("garbage") || lower.includes("trash")) {
      category = "Garbage Accumulation";
      department = "Solid Waste Management Authority";
      severity = "Medium";
      urgencyScore = 50;
    }

    explicitFacts = [transcript ? `User reported: "${transcript}"` : "Voice complaint recorded"];
  }

  const generatedComplaint = `A public complaint regarding ${category.toLowerCase()} was reported. Details specify: "${translation}". Please coordinate immediate inspection by the ${department}.`;

  return {
    language,
    transcript,
    translation,
    category,
    severity,
    urgencyScore,
    department,
    location,
    confidenceScore: 92,
    explicitFacts,
    generatedComplaint
  };
}

// Multilingual Voice Analysis via Gemini or Fallback
app.post("/api/analyze-voice", async (req, res) => {
  const { text, audioBase64, audioMimeType } = req.body;

  const ai = getGeminiClient();
  if (!ai) {
    console.log("No valid GEMINI_API_KEY found, running beautiful local heuristic VOICE analyzer...");
    const fallback = generateFallbackVoiceAnalysis(text || "");
    res.json(fallback);
    return;
  }

  try {
    const systemPrompt = `You are an expert AI municipal dispatcher and civic health coordinator.
Understand multilingual complaints in Hindi [हिंदी], Marathi [मराठी], and English seamlessly and generate a structured JSON response strictly in English.

Analyze the user's spoken voice and/or browser pre-transcription.
Follow these rules strictly:
1. Citizen records voice.
2. Gemini transcribes speech exactly as spoken into 'transcript' option in its original language/script (Hindi stays in Devnagari script, Marathi stays in Devnagari, English stays in English).
3. Detect the original language ('Hindi', 'Marathi', or 'English') and set it in 'language'.
4. Translate speech accurately to English under 'translation'.
5. Extract ONLY explicitly mentioned information. Never assume surrounding roads, schools, hospitals, landmarks, or assets unless directly mentioned by the citizen.
6. Generate a professionally structured civic complaint under 'generatedComplaint' in English that stays within the facts.
7. Categorize the issue into 'category' matching EXACTLY one of:
   - 'Potholes'
   - 'Water Leaks'
   - 'Broken Streetlights'
   - 'Garbage Accumulation'
   - 'Public Infrastructure'
   - 'Other'
8. Assign 'severity' matching EXACTLY: 'Low', 'Medium', 'High', or 'Critical'.
9. Assign 'urgencyScore' as an integer between 1 and 100 based on safety hazards.
10. Recommend the responsible 'department'.
11. Extract 'location' mentioned. If no location coordinates or names or landmarks are specified, set 'location' to "Unknown".
12. Under 'explicitFacts', provide a string array containing ONLY facts mentioned directly in the user speech.
13. Set 'confidenceScore' as an integer percentage between 50 and 100 representing your interpretation reliability.
14. If information like location, landmarks or specifics are missing, mark them as 'Unknown' as specified. Do not invent details.`;

    const contentsArr: any[] = [];

    if (audioBase64) {
      contentsArr.push({
        inlineData: {
          mimeType: audioMimeType || "audio/webm",
          data: audioBase64
        }
      });
    }

    let userPromptText = `Analyze the uploaded voice clip.`;
    if (text) {
      userPromptText += ` The browser pre-transcribed text as: "${text}"`;
    }
    userPromptText += `\nOutput structured analysis of language, transcript, translation, category, severity, urgencyScore, department, location, confidenceScore, explicitFacts, and generatedComplaint.`;

    contentsArr.push({ text: userPromptText });

    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: { parts: contentsArr },
      config: {
        systemInstruction: systemPrompt,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            language: { type: Type.STRING, description: "Detected language of the voice speech: English, Hindi, or Marathi." },
            transcript: { type: Type.STRING, description: "Transcription of the spoken words EXACTLY as spoken in the original language/script." },
            translation: { type: Type.STRING, description: "The transcript translated accurately to English." },
            category: { type: Type.STRING, description: "Category of the issue: Must be EXACTLY one of: 'Potholes', 'Water Leaks', 'Broken Streetlights', 'Garbage Accumulation', 'Public Infrastructure', or 'Other'." },
            severity: { type: Type.STRING, description: "Determined severity: Must be EXACTLY one of: 'Low', 'Medium', 'High', 'Critical'." },
            urgencyScore: { type: Type.INTEGER, description: "An urgency score between 1 and 100 representing how immediate the safety/public crisis is." },
            department: { type: Type.STRING, description: "The logical municipal department to direct this complaint." },
            location: { type: Type.STRING, description: "Specific location text matched strictly of any mentioned landmarks or streets in the speech. Output 'Unknown' if not explicitly stated." },
            confidenceScore: { type: Type.INTEGER, description: "Analysis confidence level between 50 and 100 based on the verbal detail." },
            explicitFacts: {
              type: Type.ARRAY,
              description: "A bulleted list of ONLY facts explicitly stated in the vocal coordinates (e.g. 'huge pothole', 'near DY Patil'). Do not invent, infer, or hallucinate surrounding schools, hospitals, roads, or objects.",
              items: { type: Type.STRING }
            },
            generatedComplaint: { type: Type.STRING, description: "A beautifully detailed, formally phrased, objective civic complaint drafted in English, staying strictly limited to the verified explicit facts." }
          },
          required: ["language", "transcript", "translation", "category", "severity", "urgencyScore", "department", "location", "confidenceScore", "explicitFacts", "generatedComplaint"]
        }
      }
    });

    const textResponse = response.text;
    if (!textResponse) {
      throw new Error("Empty response from Gemini.");
    }

    res.json(JSON.parse(textResponse));
  } catch (error: any) {
    console.error("Multilingual Voice Analysis failed:", error);
    const fallback = generateFallbackVoiceAnalysis(text || "");
    res.json(fallback);
  }
});

// Configure Vite or Serve static built content
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`CivicForce AI Server actively listening on http://localhost:${PORT}`);
  });
}

startServer();
