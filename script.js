const DATA_URL = 'https://warfrontlivebackend.onrender.com/tagged_messages.json';
const CACHE_URL = 'https://warfrontlivebackend.onrender.com/location_cache.json';
let map;
let markerClusterGroup;
let rectangleLayerGroup; // New layer group for rectangles (kept for backward compatibility)
let regionMarkersGroup; // New layer group for region markers

const messageStore = {};
const regionStore = {}; // Store region data for quick lookup
let nextMsgId = 0;
let nextRegionId = 0;
let allMessages = [];  // store all messages loaded from file
let locationCache = {}; // store location coordinates from cache.json
let filteredEventsMessages = []; // for events view filtering
let currentView = 'map'; // track current view
let currentSelectedRegion = null; // Track currently selected region

document.addEventListener('DOMContentLoaded', initMap);

async function initMap() {
  map = L.map('map').setView([31.5, 34.47], 8);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);

  // Create the marker cluster group with custom click behavior
  markerClusterGroup = L.markerClusterGroup({
    disableClusteringAtZoom: 18, // Still allow clustering but disable at high zoom
    maxClusterRadius: 50, // Adjust cluster radius as needed
  });
  
  // Create layer group for rectangles (bounding boxes)
  rectangleLayerGroup = L.layerGroup();
  
  // Create layer group for region markers
  regionMarkersGroup = L.layerGroup();
  
  // Add custom click handler for clusters
  markerClusterGroup.on('clusterclick', function(event) {
    // Prevent default zoom behavior
    event.originalEvent.preventDefault();
    event.originalEvent.stopPropagation();
    
    // Get all markers in this cluster
    const markers = event.layer.getAllChildMarkers();
    showClusterDetails(markers);
    
    return false; // Prevent further event propagation
  });
  
  map.addLayer(markerClusterGroup);
  // Don't add rectangle layer by default - we'll add it only when needed
  // map.addLayer(rectangleLayerGroup); // Always add rectangle layer for bounding boxes
  map.addLayer(regionMarkersGroup);

  // Add click handler to hide bounding box when clicking elsewhere on map
  map.on('click', function(e) {
    // Only hide if we didn't click on a marker
    if (!e.originalEvent.target.closest('.leaflet-marker-icon') && 
        !e.originalEvent.target.closest('.leaflet-popup')) {
      if (currentSelectedRegion) {
        closeDetails();
      }
    }
  });

  try {
    // Add cache-busting parameter to prevent stale data
    const cacheBuster = new Date().getTime();
    
    // Load both messages and location cache
    const [messagesRes, cacheRes] = await Promise.all([
      fetch(`${DATA_URL}?t=${cacheBuster}`),
      fetch(`${CACHE_URL}?t=${cacheBuster}`)
    ]);
    
    if (!messagesRes.ok) throw new Error('Failed to load messages: ' + messagesRes.statusText);
    if (!cacheRes.ok) throw new Error('Failed to load cache: ' + cacheRes.statusText);
    
    allMessages = await messagesRes.json();
    const rawLocationCache = await cacheRes.json();
    
    // Normalize location cache keys to lowercase for consistent lookup
    locationCache = {};
    Object.keys(rawLocationCache).forEach(key => {
      const normalizedKey = key.trim().toLowerCase();
      locationCache[normalizedKey] = rawLocationCache[key];
      console.log(`Normalizing cache key: "${key}" -> "${normalizedKey}"`);
    });
    
    console.log('Final location cache keys:', Object.keys(locationCache));
    
    // Debug: Log data info to console
    console.log(`Loaded ${allMessages.length} messages`);
    console.log(`Loaded ${Object.keys(locationCache).length} cached locations`);
    console.log('Sample message:', allMessages[0]);
    console.log('Sample cache entry:', Object.entries(locationCache)[0]);
    console.log('All location cache keys (first 20):', Object.keys(locationCache).slice(0, 20));
    
    // Debug: Show what locations are mentioned in messages vs what's in cache
    const allMessageLocations = new Set();
    allMessages.forEach(msg => {
      if (msg.locations) {
        msg.locations.forEach(loc => {
          allMessageLocations.add(loc.trim().toLowerCase());
        });
      }
    });
    console.log('Unique locations mentioned in messages (first 20):', Array.from(allMessageLocations).slice(0, 20));
    console.log('Cache keys (first 20):', Object.keys(locationCache).slice(0, 20));
    
    // Find which message locations have cache matches
    const matchedLocations = [];
    const unmatchedLocations = [];
    allMessageLocations.forEach(msgLoc => {
      if (locationCache[msgLoc]) {
        matchedLocations.push(msgLoc);
      } else {
        unmatchedLocations.push(msgLoc);
      }
    });
    console.log('Matched locations:', matchedLocations);
    console.log('Unmatched locations:', unmatchedLocations);
    


    // Initialize filter inputs to min/max dates from data
    initDateFilterInputs(allMessages);

    // Show all markers initially
    refreshMarkers(allMessages);
    
    // Initialize events data
    initEventsData(allMessages);
    
    // Pre-render events timeline if we have data
    if (allMessages.length > 0) {
      filteredEventsMessages = [...allMessages].sort((a, b) => new Date(b.date) - new Date(a.date));
      renderEventsTimeline(filteredEventsMessages);
      updateEventsStats(filteredEventsMessages);
    }
  } catch (err) {
    console.error(err);
    alert('Error loading or processing data.');
  } finally {
    document.getElementById('loading').style.display = 'none';
  }

  setupFilterListeners();
  
  // Check if we need to navigate to a specific location from URL hash
  checkForLocationNavigation();
}

// Check URL hash for location navigation (from events page)
function checkForLocationNavigation() {
  const hash = window.location.hash;
  if (hash.startsWith('#location=')) {
    const locationName = decodeURIComponent(hash.substring(10));
    // Wait a bit for the map to be fully loaded
    setTimeout(() => {
      goToLocation(locationName);
    }, 1000);
  }
}

// Initialize date inputs with min/max dates from the data
function initDateFilterInputs(messages) {
  if (!messages.length) return;
  const dates = messages.map(m => new Date(m.date));
  const minDate = new Date(Math.min(...dates));
  const maxDate = new Date(Math.max(...dates));
  const toDateInputValue = d => d.toISOString().split('T')[0];

  document.getElementById('start-date').value = toDateInputValue(minDate);
  document.getElementById('start-date').min = toDateInputValue(minDate);
  document.getElementById('start-date').max = toDateInputValue(maxDate);

  document.getElementById('end-date').value = toDateInputValue(maxDate);
  document.getElementById('end-date').min = toDateInputValue(minDate);
  document.getElementById('end-date').max = toDateInputValue(maxDate);
}

// Attach event listeners for date inputs and clear filter button
function setupFilterListeners() {
  document.getElementById('start-date').addEventListener('change', onFilterChange);
  document.getElementById('end-date').addEventListener('change', onFilterChange);
  
  // Layer toggle listeners
  document.getElementById('show-markers').addEventListener('change', onLayerToggle);
  document.getElementById('show-regions').addEventListener('change', onLayerToggle);
  
  document.getElementById('clear-filter').addEventListener('click', () => {
    // Clear date inputs so no filter applies
    document.getElementById('start-date').value = '';
    document.getElementById('end-date').value = '';
    // Refresh all markers without any filtering
    refreshMarkers(allMessages);
  });
}

// Called whenever date filter inputs change
function onFilterChange() {
  const startDate = new Date(document.getElementById('start-date').value);
  const endDate = new Date(document.getElementById('end-date').value);
  if (startDate > endDate) {
    alert("Start date can't be after End date.");
    return;
  }
  // Filter messages by date range (inclusive)
  const filtered = allMessages.filter(m => {
    const d = new Date(m.date);
    return d >= startDate && d <= endDate;
  });
  refreshMarkers(filtered);
}

// Called when layer toggle checkboxes change
function onLayerToggle() {
  const showMarkers = document.getElementById('show-markers').checked;
  const showRegions = document.getElementById('show-regions').checked;
  
  // Toggle layer visibility
  if (showMarkers) {
    map.addLayer(markerClusterGroup);
  } else {
    map.removeLayer(markerClusterGroup);
  }
  
  if (showRegions) {
    map.addLayer(regionMarkersGroup);
    // Ensure rectangle layer is available but don't show rectangles by default
    if (!map.hasLayer(rectangleLayerGroup)) {
      map.addLayer(rectangleLayerGroup);
    }
  } else {
    map.removeLayer(regionMarkersGroup);
    // Hide any selected region when regions are toggled off
    if (currentSelectedRegion) {
      closeDetails();
    }
    // Remove rectangle layer when regions are disabled
    if (map.hasLayer(rectangleLayerGroup)) {
      map.removeLayer(rectangleLayerGroup);
    }
  }
}

// Clear and redraw markers and regions for given messages
function refreshMarkers(messages) {
  markerClusterGroup.clearLayers();
  rectangleLayerGroup.clearLayers();
  regionMarkersGroup.clearLayers();
  Object.keys(messageStore).forEach(k => delete messageStore[k]);
  Object.keys(regionStore).forEach(k => delete regionStore[k]);
  nextMsgId = 0;
  nextRegionId = 0;
  currentSelectedRegion = null; // Reset selected region

  messages.forEach(msg => {
    if (!msg.locations || msg.locations.length === 0) return;
    
    // Look up each location in the cache
    msg.locations.forEach(location => {
      // Handle potential null/undefined location names
      if (!location || typeof location !== 'string') {
        console.warn('Invalid location name:', location);
        return;
      }
      
      const locationKey = location.trim().toLowerCase();
      if (!locationKey) {
        console.warn('Empty location name after trimming:', location);
        return;
      }
      
      console.log(`Looking up location: "${location}" -> normalized key: "${locationKey}"`);
      const coord = locationCache[locationKey];
      console.log(`Found coordinate:`, coord);
      
      if (coord && coord !== null) {
        addLocationToMap(coord, msg, location);
      } else if (coord === null) {
        console.warn(`Location "${location}" explicitly set to null in cache (geocoding failed)`);
      } else {
        console.warn(`Location "${location}" not found in cache. Looking for key: "${locationKey}"`);
        // Debug: Show all available keys for comparison
        console.log(`Available cache keys:`, Object.keys(locationCache));
        // Debug: Show similar keys for troubleshooting
        const similarKeys = Object.keys(locationCache).filter(key => 
          key.includes(locationKey.split(' ')[0]) || locationKey.includes(key.split(' ')[0])
        );
        if (similarKeys.length > 0) {
          console.log(`Similar keys found:`, similarKeys);
        }
      }
    });
  });
}

function addLocationToMap(coord, msg, locationName) {
  const msgId = `msg_${nextMsgId++}`;
  messageStore[msgId] = msg;

  const popupContent = `
    <div class="popup-cleaned" onclick="showDetailsFromStore('${msgId}')">
      <strong>${locationName}:</strong><br>
      ${msg.cleaned_text}
    </div>
  `;

  // Check if it's a bounding box (has north, south, east, west) or point coordinates (has lat, lon)
  if (coord.north !== undefined && coord.south !== undefined && coord.east !== undefined && coord.west !== undefined) {
    // It's a bounding box - create or update a region marker
    const centerLat = (coord.north + coord.south) / 2;
    const centerLon = (coord.east + coord.west) / 2;
    
    // Check if we already have a region for this location
    const existingRegionId = Object.keys(regionStore).find(id => 
      regionStore[id].name === locationName && 
      regionStore[id].bounds.north === coord.north &&
      regionStore[id].bounds.south === coord.south &&
      regionStore[id].bounds.east === coord.east &&
      regionStore[id].bounds.west === coord.west
    );
    
    if (existingRegionId) {
      // Add message to existing region
      regionStore[existingRegionId].messages.push(msg);
      // Update the region marker tooltip to reflect new count
      updateRegionMarker(existingRegionId);
    } else {
      // Create new region
      const regionId = `region_${nextRegionId++}`;
      
      // Store region data for lookup
      regionStore[regionId] = {
        name: locationName,
        bounds: {
          north: coord.north,
          south: coord.south,
          east: coord.east,
          west: coord.west
        },
        messages: [msg],
        center: [centerLat, centerLon]
      };
      
      // Create a custom colored marker for regions
      const regionIcon = L.divIcon({
        className: 'region-marker',
        html: `<div class="region-marker-icon" style="background-color: #ff6b35; border: 2px solid #fff; border-radius: 50%; width: 18px; height: 18px; box-shadow: 0 2px 6px rgba(0,0,0,0.3);"></div>`,
        iconSize: [22, 22],
        iconAnchor: [11, 11]
      });
      
      const regionMarker = L.marker([centerLat, centerLon], { icon: regionIcon });
      
      // Store reference to marker for updates
      regionStore[regionId].marker = regionMarker;
      
      // Add click handler to show all messages in the region
      regionMarker.on('click', function() {
        showRegionDetails(regionId);
      });
      
      // Add tooltip showing region name
      regionMarker.bindTooltip(`📍 ${locationName} (1 message)`, {
        permanent: false,
        direction: 'top',
        offset: [0, -10]
      });
      
      regionMarkersGroup.addLayer(regionMarker);
      
      // Also keep the rectangle for potential future use (but hidden by default)
      const bounds = [
        [coord.south, coord.west], // Southwest corner
        [coord.north, coord.east]  // Northeast corner
      ];
      
      const rectangle = L.rectangle(bounds, {
        color: '#ff6b35',
        weight: 3,
        opacity: 0, // Start hidden
        fillColor: '#ff6b35',
        fillOpacity: 0 // Start hidden
      });
      
      // Store reference to rectangle in region data
      regionStore[regionId].rectangle = rectangle;
      
      rectangle.bindPopup(popupContent);
      rectangleLayerGroup.addLayer(rectangle); // Add to rectangle layer group (hidden)
    }
  } else if (coord.lat !== undefined && coord.lon !== undefined) {
    // It's point coordinates - create a marker
    const marker = L.marker([coord.lat, coord.lon]);
    marker.bindPopup(popupContent);
    markerClusterGroup.addLayer(marker); // Add to cluster group for clustering
  } else {
    console.warn('Invalid coordinate format for location "' + locationName + '":', coord);
  }
}

function updateRegionMarker(regionId) {
  const region = regionStore[regionId];
  if (!region || !region.marker) return;
  
  const messageCount = region.messages.length;
  
  // Choose color based on message count
  let color = '#ff6b35'; // default orange
  let activityClass = '';
  
  if (messageCount >= 10) {
    color = '#dc2626'; // red for high activity
    activityClass = 'high-activity';
  } else if (messageCount >= 5) {
    color = '#f59e0b'; // amber for medium activity
  }
  
  // Update the marker icon
  const regionIcon = L.divIcon({
    className: 'region-marker',
    html: `<div class="region-marker-icon ${activityClass}" style="background-color: ${color}; border: 2px solid #fff; border-radius: 50%; width: 18px; height: 18px; box-shadow: 0 2px 6px rgba(0,0,0,0.3);"></div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11]
  });
  
  region.marker.setIcon(regionIcon);
  
  // Update tooltip
  const plural = messageCount === 1 ? 'message' : 'messages';
  region.marker.setTooltipContent(`📍 ${region.name} (${messageCount} ${plural})`);
}

function showRegionDetails(regionId) {
  const region = regionStore[regionId];
  if (!region) return;

  // Ensure rectangle layer is added to map
  if (!map.hasLayer(rectangleLayerGroup)) {
    map.addLayer(rectangleLayerGroup);
  }

  // Hide ALL region bounding boxes first
  Object.keys(regionStore).forEach(id => {
    const regionData = regionStore[id];
    if (regionData && regionData.rectangle) {
      regionData.rectangle.setStyle({
        opacity: 0,
        fillOpacity: 0
      });
    }
  });

  // Show ONLY the current region's bounding box
  if (region.rectangle) {
    region.rectangle.setStyle({
      opacity: 0.8,
      fillOpacity: 0.15
    });
  }

  // Set current selected region
  currentSelectedRegion = regionId;

  // Find all messages within this region's bounds (including sub-regions)
  const messagesInRegion = findMessagesInRegion(region.bounds);
  
  // Categorize messages for better understanding
  const directMessages = region.messages || [];
  const totalMessages = messagesInRegion.length;
  const additionalMessages = totalMessages - directMessages.length;
  
  // Get unique channels from all messages
  const channels = [...new Set(messagesInRegion.map(msg => msg.channel))];
  
  document.getElementById('details-title').textContent = `Region: ${region.name}`;
  
  let content = `
    <div class="region-details">
      <div class="region-info">
        <strong>Region:</strong> ${region.name}<br>
        <strong>Messages about this region:</strong> ${directMessages.length}<br>
        <strong>Messages from areas within:</strong> ${additionalMessages}<br>
        <strong>Total Messages:</strong> ${totalMessages}<br>
        <strong>Channels:</strong> ${channels.join(', ')}
      </div>
      <div class="region-messages">
        <h4>All messages in this region (showing most recent first):</h4>
  `;
  
  if (messagesInRegion.length === 0) {
    content += '<p>No messages found in this region.</p>';
  } else {
    messagesInRegion.slice(0, 20).forEach((msg, index) => {
      const date = new Date(msg.date).toLocaleString();
      const relativeDate = getRelativeTime(msg.date);
      
      // Determine if this is a direct message or contained message
      const isDirect = directMessages.some(dm => 
        dm.id === msg.id || (dm.text === msg.text && dm.date === msg.date)
      );
      
      const messageType = isDirect ? 'region' : 'sub-area';
      const borderColor = isDirect ? '#ff6b35' : '#10b981';
      const typeLabel = isDirect ? 'About Region' : 'Within Area';
      
      // Create clickable location links
      const locationLinks = (msg.locations || []).map(location => {
        const locationKey = location.trim().toLowerCase();
        const coord = locationCache[locationKey];
        
        if (coord && coord !== null) {
          return `<span class="clickable-location" onclick="goToLocation('${location}')">${location}</span>`;
        } else {
          return location; // Non-clickable if no coordinates
        }
      }).join(', ');
      
      content += `
        <div class="message-item" style="margin-bottom: 10px; padding: 8px; border-left: 3px solid ${borderColor}; background: #f9f9f9;">
          <div class="message-header" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
            <span class="message-type" style="font-size: 0.7em; background: ${borderColor}; color: white; padding: 2px 6px; border-radius: 10px; font-weight: bold;">${typeLabel}</span>
            <span class="message-time" style="font-size: 0.7em; color: #666;">${relativeDate}</span>
          </div>
          <div class="message-text" style="font-size: 0.9em; margin-bottom: 4px;">${msg.cleaned_text || msg.text}</div>
          <div class="message-meta" style="font-size: 0.8em; color: #666;">
            <strong>Channel:</strong> ${msg.channel} | 
            <strong>Date:</strong> ${date}
            ${locationLinks ? ` | <strong>Locations:</strong> ${locationLinks}` : ''}
          </div>
        </div>
      `;
    });
    
    if (messagesInRegion.length > 20) {
      content += `<p style="color: #666; font-style: italic;">... and ${messagesInRegion.length - 20} more messages</p>`;
    }
  }
  
  content += '</div></div>';
  
  document.getElementById('details-content').innerHTML = content;
  document.getElementById('details').style.display = 'block';
}

function closeDetails() {
  // Hide the details panel
  document.getElementById('details').style.display = 'none';
  
  // Hide ALL region bounding boxes
  Object.keys(regionStore).forEach(id => {
    const regionData = regionStore[id];
    if (regionData && regionData.rectangle) {
      regionData.rectangle.setStyle({
        opacity: 0,
        fillOpacity: 0
      });
    }
  });
  
  currentSelectedRegion = null;
  
  // Remove rectangle layer when no region is selected
  if (map.hasLayer(rectangleLayerGroup)) {
    map.removeLayer(rectangleLayerGroup);
  }
}

function getRelativeTime(dateString) {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now - date;
  const diffMinutes = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  
  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`;
  } else if (diffHours < 24) {
    return `${diffHours}h ago`;
  } else if (diffDays < 7) {
    return `${diffDays}d ago`;
  } else {
    return `${Math.floor(diffDays / 7)}w ago`;
  }
}

function findMessagesInRegion(regionBounds) {
  const messagesInRegion = [];
  const addedMessages = new Set(); // Track messages to avoid duplicates
  
  // Check ALL messages from the dataset, not just messageStore
  allMessages.forEach(msg => {
    if (!msg.locations || msg.locations.length === 0) return;
    
    let messageIncluded = false;
    
    msg.locations.forEach(location => {
      // Skip if we already added this message
      if (messageIncluded) return;
      
      const locationKey = location.trim().toLowerCase();
      const coord = locationCache[locationKey];
      
      if (!coord) return;
      
      // Check if this location is within the region bounds
      if (isLocationInBounds(coord, regionBounds)) {
        // Create unique identifier for message
        const messageId = msg.id || `${msg.text}_${msg.date}_${msg.channel}`;
        
        if (!addedMessages.has(messageId)) {
          messagesInRegion.push(msg);
          addedMessages.add(messageId);
          messageIncluded = true;
        }
      }
    });
  });
  
  console.log(`Found ${messagesInRegion.length} messages in region bounds:`, regionBounds);
  
  return messagesInRegion.sort((a, b) => new Date(b.date) - new Date(a.date));
}

function isLocationInBounds(coord, bounds) {
  // Handle point coordinates (individual markers)
  if (coord.lat !== undefined && coord.lon !== undefined) {
    const withinBounds = coord.lat >= bounds.south && coord.lat <= bounds.north &&
                        coord.lon >= bounds.west && coord.lon <= bounds.east;
    
    if (withinBounds) {
      console.log(`Point location [${coord.lat}, ${coord.lon}] is within bounds:`, bounds);
    }
    
    return withinBounds;
  }
  
  // Handle bounding box coordinates (sub-regions)
  if (coord.north !== undefined && coord.south !== undefined && 
      coord.east !== undefined && coord.west !== undefined) {
    
    // Check if the sub-region overlaps with the main region
    // Two rectangles overlap if they don't NOT overlap
    const overlaps = !(coord.south > bounds.north || coord.north < bounds.south ||
                      coord.west > bounds.east || coord.east < bounds.west);
    
    if (overlaps) {
      console.log(`Sub-region overlaps with main region:`, {
        subRegion: coord,
        mainRegion: bounds
      });
    }
    
    return overlaps;
  }
  
  console.warn('Invalid coordinate format:', coord);
  return false;
}

function showDetailsFromStore(msgId) {
  const msg = messageStore[msgId];
  if (!msg) return;

  // Create clickable location links only for locations with valid coordinates
  const validLocationLinks = (msg.locations || []).map(location => {
    const locationKey = location.trim().toLowerCase();
    const coord = locationCache[locationKey];
    
    if (coord && coord !== null) {
      return `<span class="clickable-location" onclick="goToLocation('${location}')">${location}</span>`;
    } else {
      return null; // Return null for locations without coordinates
    }
  }).filter(link => link !== null); // Filter out null values

  // Only show locations section if there are valid locations
  const locationsSection = validLocationLinks.length > 0 
    ? `<br><strong>Extracted Locations:</strong> ${validLocationLinks.join(', ')}`
    : '';

  document.getElementById('details-title').textContent = 'Message Details';
  document.getElementById('details-content').innerHTML = `
    <div class="message-item">
      <div class="message-text"><strong>Original Text:</strong></div>
      <div class="original-text">${msg.text}</div>
      <div class="message-meta">
        <strong>Channel:</strong> ${msg.channel}<br>
        <strong>Date:</strong> ${new Date(msg.date).toLocaleString()}${locationsSection}
      </div>
    </div>
  `;

  document.getElementById('details').style.display = 'block';
}

function showClusterDetails(markers) {
  const messages = markers.map(marker => {
    // Extract message ID from popup content
    const popupContent = marker.getPopup().getContent();
    const msgIdMatch = popupContent.match(/showDetailsFromStore\('([^']+)'\)/);
    if (msgIdMatch) {
      return messageStore[msgIdMatch[1]];
    }
    return null;
  }).filter(msg => msg !== null);

  if (messages.length === 0) return;

  document.getElementById('details-title').textContent = `Cluster Details (${messages.length} messages)`;
  
  const contentHtml = messages.map(msg => {
    // Create clickable location links only for locations with valid coordinates
    const validLocationLinks = (msg.locations || []).map(location => {
      const locationKey = location.trim().toLowerCase();
      const coord = locationCache[locationKey];
      
      if (coord && coord !== null) {
        return `<span class="clickable-location" onclick="goToLocation('${location}')">${location}</span>`;
      } else {
        return null; // Return null for locations without coordinates
      }
    }).filter(link => link !== null); // Filter out null values

    // Only show locations section if there are valid locations
    const locationsSection = validLocationLinks.length > 0 
      ? ` | <strong>Locations:</strong> ${validLocationLinks.join(', ')}`
      : '';

    return `
      <div class="message-item">
        <div class="original-text">${msg.text}</div>
        <div class="message-meta">
          <strong>Channel:</strong> ${msg.channel} | 
          <strong>Date:</strong> ${new Date(msg.date).toLocaleString()}${locationsSection}
        </div>
      </div>
    `;
  }).join('');

  document.getElementById('details-content').innerHTML = contentHtml;
  document.getElementById('details').style.display = 'block';
}

// Function to navigate to a specific location on the map
function goToLocation(locationName) {
  const locationKey = locationName.trim().toLowerCase();
  const coord = locationCache[locationKey];
  
  if (!coord || coord === null) {
    console.warn(`Cannot navigate to location "${locationName}" - no coordinates found`);
    return;
  }

  // Check if it's a bounding box or point coordinates
  if (coord.north !== undefined && coord.south !== undefined && coord.east !== undefined && coord.west !== undefined) {
    // It's a bounding box - fit the map to the bounds
    const bounds = [
      [coord.south, coord.west], // Southwest corner
      [coord.north, coord.east]  // Northeast corner
    ];
    map.fitBounds(bounds, { padding: [20, 20] });
  } else if (coord.lat !== undefined && coord.lon !== undefined) {
    // It's point coordinates - center the map on the point
    map.setView([coord.lat, coord.lon], 15); // Zoom level 15 for point locations
  } else {
    console.warn('Invalid coordinate format for location "' + locationName + '":', coord);
  }
}

// View switching functionality
function toggleView() {
  const newView = currentView === 'map' ? 'events' : 'map';
  const toggleButton = document.getElementById('view-toggle');
  
  currentView = newView;
  
  // Hide all views
  document.querySelectorAll('.view-container').forEach(view => {
    view.classList.remove('active');
  });
  
  // Show selected view
  document.getElementById(newView + '-view').classList.add('active');
  
  // Update button text
  if (newView === 'map') {
    toggleButton.innerHTML = '📅 Switch to Events Timeline';
  } else {
    toggleButton.innerHTML = '🗺️ Switch to Map View';
  }
  
  // If switching to events view, ensure data is loaded and rendered
  if (newView === 'events') {
    if (filteredEventsMessages.length === 0 && allMessages.length > 0) {
      filteredEventsMessages = [...allMessages].sort((a, b) => new Date(b.date) - new Date(a.date));
    }
    renderEventsTimeline(filteredEventsMessages);
    updateEventsStats(filteredEventsMessages);
  }
  
  // If switching back to map, invalidate size to fix display issues
  if (newView === 'map' && map) {
    setTimeout(() => {
      map.invalidateSize();
    }, 100);
  }
}

// Initialize events data
function initEventsData(messages) {
  // Sort messages by date (newest first)
  const sortedMessages = [...messages].sort((a, b) => new Date(b.date) - new Date(a.date));
  
  // Initialize events date filter inputs
  initEventsDateFilterInputs(sortedMessages);
  
  // Initialize channel filter dropdown
  initChannelFilter(sortedMessages);
  
  filteredEventsMessages = sortedMessages;
}

function initEventsDateFilterInputs(messages) {
  if (!messages.length) return;
  
  const dates = messages.map(m => new Date(m.date));
  const minDate = new Date(Math.min(...dates));
  const maxDate = new Date(Math.max(...dates));
  const toDateInputValue = d => d.toISOString().split('T')[0];

  document.getElementById('events-start-date').value = toDateInputValue(minDate);
  document.getElementById('events-start-date').min = toDateInputValue(minDate);
  document.getElementById('events-start-date').max = toDateInputValue(maxDate);

  document.getElementById('events-end-date').value = toDateInputValue(maxDate);
  document.getElementById('events-end-date').min = toDateInputValue(minDate);
  document.getElementById('events-end-date').max = toDateInputValue(maxDate);
}

function initChannelFilter(messages) {
  const channelSelect = document.getElementById('events-channel-filter');
  if (!channelSelect || !messages.length) return;

  // Get unique channels from messages
  const uniqueChannels = [...new Set(messages.map(m => m.channel))].sort();
  
  // Clear existing options except "All Channels"
  channelSelect.innerHTML = '<option value="">All Channels</option>';
  
  // Add channel options
  uniqueChannels.forEach(channel => {
    const option = document.createElement('option');
    option.value = channel;
    option.textContent = channel;
    channelSelect.appendChild(option);
  });

  console.log('Channel filter initialized with channels:', uniqueChannels);
}

function applyEventsFilters() {
  const startDateInput = document.getElementById('events-start-date').value;
  const endDateInput = document.getElementById('events-end-date').value;
  const searchText = document.getElementById('events-search-text').value.toLowerCase().trim();
  const selectedChannel = document.getElementById('events-channel-filter').value;

  console.log('Raw filter inputs:', {
    startDateInput,
    endDateInput,
    searchText,
    selectedChannel,
    totalMessages: allMessages.length
  });

  // Handle date filtering - if ANY date is specified, use it
  let startDate = null;
  let endDate = null;
  
  if (startDateInput || endDateInput) {
    // If only one date is specified, create a range
    if (startDateInput && !endDateInput) {
      // Create start of day in UTC to match message timezone
      startDate = new Date(startDateInput + 'T00:00:00.000Z');
      endDate = new Date(startDateInput + 'T23:59:59.999Z');
    } else if (!startDateInput && endDateInput) {
      // Create start of day in UTC to match message timezone  
      startDate = new Date(endDateInput + 'T00:00:00.000Z');
      endDate = new Date(endDateInput + 'T23:59:59.999Z');
    } else {
      // Both dates specified - create full day ranges in UTC
      startDate = new Date(startDateInput + 'T00:00:00.000Z');
      endDate = new Date(endDateInput + 'T23:59:59.999Z');
    }
    
    if (startDate > endDate) {
      alert("Start date can't be after end date.");
      return;
    }
  }

  console.log('Processed filter inputs:', {
    startDate: startDate ? startDate.toISOString() : 'none',
    endDate: endDate ? endDate.toISOString() : 'none',
    searchText,
    timezone: 'Filter dates created in UTC to match message data'
  });

  // Debug: Log sample message dates to understand the data format
  if (allMessages.length > 0) {
    console.log('Sample message dates from data:', allMessages.slice(0, 3).map(msg => ({
      originalDate: msg.date,
      parsedDate: new Date(msg.date).toISOString(),
      dateObject: new Date(msg.date)
    })));
  }

  filteredEventsMessages = allMessages.filter(msg => {
    // Date filter - only apply if we have valid dates
    let passesDateFilter = true;
    if (startDate && endDate) {
      const msgDate = new Date(msg.date);
      passesDateFilter = msgDate >= startDate && msgDate <= endDate;
      
      // Debug: Log date comparisons for first few messages
      if (allMessages.indexOf(msg) < 3) {
        console.log('Date comparison debug:', {
          msgDateOriginal: msg.date,
          msgDateParsed: msgDate.toISOString(),
          startDateFilter: startDate.toISOString(),
          endDateFilter: endDate.toISOString(),
          msgDateMs: msgDate.getTime(),
          startDateMs: startDate.getTime(),
          endDateMs: endDate.getTime(),
          passesDateFilter,
          msgDateGeStartDate: msgDate >= startDate,
          msgDateLeEndDate: msgDate <= endDate
        });
      }
    }

    // Enhanced text search filter
    const passesTextFilter = !searchText || isTextMatch(msg, searchText);

    // Channel filter
    const passesChannelFilter = !selectedChannel || msg.channel === selectedChannel;

    // Debug logging for search issues
    if (searchText === 'gaza' && passesTextFilter) {
      console.log('Found gaza match:', msg);
    }

    const passes = passesDateFilter && passesTextFilter && passesChannelFilter;
    
    // Log first few results for debugging
    if (searchText === 'gaza') {
      console.log('Message filter result:', {
        msgDate: new Date(msg.date).toISOString(),
        passesDateFilter,
        passesTextFilter,
        passesChannelFilter,
        passes,
        text: msg.text?.substring(0, 100)
      });
    }

    return passes;
  });

  console.log('Filtered results:', {
    totalMessages: allMessages.length,
    filteredCount: filteredEventsMessages.length,
    hasStartDate: !!startDate,
    hasEndDate: !!endDate,
    hasSearchText: !!searchText,
    hasChannelFilter: !!selectedChannel,
    selectedChannel: selectedChannel || 'All Channels',
    sampleFilteredMessages: filteredEventsMessages.slice(0, 2).map(msg => ({
      date: msg.date,
      channel: msg.channel,
      text: msg.text?.substring(0, 50)
    }))
  });

  renderEventsTimeline(filteredEventsMessages);
  updateEventsStats(filteredEventsMessages);
}

// Enhanced search function with multiple search strategies
function isTextMatch(msg, searchText) {
  // If no search text, everything matches
  if (!searchText) return true;
  
  // Split search text into individual words for more flexible matching
  const searchWords = searchText.toLowerCase()
    .split(/\s+/)
    .filter(word => word.length > 0);
  
  if (searchWords.length === 0) return true;

  // Prepare text fields for searching (normalize text)
  const textFields = [
    msg.text || '',
    msg.cleaned_text || '', 
    msg.channel || '',
    ...(msg.locations || [])
  ].map(field => normalizeText(field.toString()));

  // Debug logging for search issues
  if (searchText === 'gaza') {
    console.log('Debugging gaza search:');
    console.log('Message:', msg);
    console.log('Search words:', searchWords);
    console.log('Text fields:', textFields);
    console.log('Original locations:', msg.locations);
  }

  // Strategy 1: All words must appear somewhere in the message (most lenient)
  const allWordsMatch = searchWords.every(word => 
    textFields.some(field => field.includes(word))
  );

  // Strategy 2: At least one field contains all search words
  const singleFieldMatch = textFields.some(field => 
    searchWords.every(word => field.includes(word))
  );

  // Strategy 3: Fuzzy matching for typos (if search is longer than 3 chars)
  const fuzzyMatch = searchWords.some(word => {
    if (word.length <= 3) return false;
    return textFields.some(field => 
      fuzzyStringMatch(field, word, 0.8) // 80% similarity threshold
    );
  });

  // Strategy 4: Partial word matching (for abbreviations or partial typing)
  const partialMatch = searchWords.some(word => {
    if (word.length <= 2) return false;
    return textFields.some(field => {
      const fieldWords = field.split(/\s+/);
      return fieldWords.some(fieldWord => 
        fieldWord.startsWith(word) || word.startsWith(fieldWord)
      );
    });
  });

  const finalMatch = allWordsMatch || singleFieldMatch || fuzzyMatch || partialMatch;

  // Debug logging for search issues
  if (searchText === 'gaza') {
    console.log('Match results:', {
      allWordsMatch,
      singleFieldMatch,
      fuzzyMatch,
      partialMatch,
      finalMatch
    });
  }

  // Return true if any strategy matches
  return finalMatch;
}

// Normalize text for better searching
function normalizeText(text) {
  return text.toLowerCase()
    .replace(/[^\w\s]/g, ' ') // Replace punctuation with spaces
    .replace(/\s+/g, ' ')     // Collapse multiple spaces
    .trim();
}

// Simple fuzzy string matching using Levenshtein distance
function fuzzyStringMatch(text, pattern, threshold = 0.8) {
  const words = text.split(/\s+/);
  return words.some(word => {
    if (Math.abs(word.length - pattern.length) > pattern.length * 0.4) {
      return false; // Too different in length
    }
    const similarity = calculateSimilarity(word, pattern);
    return similarity >= threshold;
  });
}

// Calculate similarity between two strings (0 = no match, 1 = perfect match)
function calculateSimilarity(str1, str2) {
  const maxLength = Math.max(str1.length, str2.length);
  if (maxLength === 0) return 1;
  
  const distance = levenshteinDistance(str1, str2);
  return (maxLength - distance) / maxLength;
}

// Levenshtein distance calculation
function levenshteinDistance(str1, str2) {
  const matrix = Array(str2.length + 1).fill(null).map(() => 
    Array(str1.length + 1).fill(null)
  );

  for (let i = 0; i <= str1.length; i++) matrix[0][i] = i;
  for (let j = 0; j <= str2.length; j++) matrix[j][0] = j;

  for (let j = 1; j <= str2.length; j++) {
    for (let i = 1; i <= str1.length; i++) {
      const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
      matrix[j][i] = Math.min(
        matrix[j][i - 1] + 1,     // insertion
        matrix[j - 1][i] + 1,     // deletion
        matrix[j - 1][i - 1] + cost // substitution
      );
    }
  }

  return matrix[str2.length][str1.length];
}

function clearEventsFilters() {
  // Reset to min/max dates instead of leaving empty
  initEventsDateFilterInputs(allMessages);
  
  // Clear search text
  document.getElementById('events-search-text').value = '';
  
  // Reset channel filter to "All Channels"
  document.getElementById('events-channel-filter').value = '';
  
  filteredEventsMessages = [...allMessages].sort((a, b) => new Date(b.date) - new Date(a.date));
  renderEventsTimeline(filteredEventsMessages);
  updateEventsStats(filteredEventsMessages);
}

function updateEventsStats(messages) {
  const statsElement = document.getElementById('events-stats');
  if (!statsElement) {
    console.error('Events stats element not found');
    return;
  }

  const totalEvents = messages.length;
  const uniqueChannels = new Set(messages.map(m => m.channel)).size;
  const dateRange = messages.length > 0 
    ? `${new Date(Math.min(...messages.map(m => new Date(m.date)))).toLocaleDateString()} - ${new Date(Math.max(...messages.map(m => new Date(m.date)))).toLocaleDateString()}`
    : 'No events';

  statsElement.innerHTML = `
    Showing <strong>${totalEvents}</strong> events from <strong>${uniqueChannels}</strong> channels | Date range: <strong>${dateRange}</strong>
  `;
  
  console.log('Events stats updated:', { totalEvents, uniqueChannels, dateRange });
}

function renderEventsTimeline(messages) {
  console.log('Rendering events timeline with', messages.length, 'messages');
  
  const timeline = document.getElementById('events-timeline');
  const noEvents = document.getElementById('no-events');

  if (!timeline || !noEvents) {
    console.error('Timeline elements not found');
    return;
  }

  if (messages.length === 0) {
    timeline.style.display = 'none';
    noEvents.style.display = 'block';
    return;
  }

  timeline.style.display = 'flex';
  noEvents.style.display = 'none';

  try {
    // Group messages by date
    const messagesByDate = {};
    messages.forEach(msg => {
      const dateKey = new Date(msg.date).toDateString();
      if (!messagesByDate[dateKey]) {
        messagesByDate[dateKey] = [];
      }
      messagesByDate[dateKey].push(msg);
    });

    // Sort dates (newest first)
    const sortedDates = Object.keys(messagesByDate).sort((a, b) => new Date(b) - new Date(a));

    timeline.innerHTML = sortedDates.map(dateKey => {
      const dayMessages = messagesByDate[dateKey];
      const formattedDate = new Date(dateKey).toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      });

      const eventsHtml = dayMessages.map(msg => {
        // Get valid locations with coordinates
        const validLocations = (msg.locations || []).filter(location => {
          const locationKey = location.trim().toLowerCase();
          const coord = locationCache[locationKey];
          return coord && coord !== null;
        });

        const locationsHtml = validLocations.length > 0
          ? `<div class="locations">
              ${validLocations.map(location => 
                `<span class="location-tag" onclick="goToLocationFromEvents('${location}')">${location}</span>`
              ).join('')}
             </div>`
          : '';

        // Escape single quotes for onclick handler
        const escapedText = msg.text.replace(/'/g, "\\'").replace(/"/g, '&quot;');

        return `
          <div class="event-item" onclick="copyToClipboard('${escapedText}')">
            <div class="event-time">
              ${new Date(msg.date).toLocaleTimeString()}
            </div>
            <div class="event-content">
              ${msg.text}
            </div>
            <div class="event-meta">
              <span class="channel">${msg.channel}</span>
              ${locationsHtml}
            </div>
          </div>
        `;
      }).join('');

      return `
        <div class="date-group">
          <div class="date-header">
            ${formattedDate} (${dayMessages.length} events)
          </div>
          <div class="events-list">
            ${eventsHtml}
          </div>
        </div>
      `;
    }).join('');
    
    console.log('Events timeline rendered successfully');
  } catch (error) {
    console.error('Error rendering events timeline:', error);
    timeline.innerHTML = '<div style="padding: 2rem; text-align: center; color: #ef4444;">Error loading events. Please try refreshing the page.</div>';
  }
}

function goToLocationFromEvents(locationName) {
  // Switch to map view first
  toggleView();
  
  // Wait a bit for the view to switch and map to be ready
  setTimeout(() => {
    goToLocation(locationName);
  }, 300);
}

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(() => {
    // Visual feedback for copy action
    const notification = document.createElement('div');
    notification.style.cssText = `
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      background: #10b981;
      color: white;
      padding: 0.75rem 1.5rem;
      border-radius: 0.5rem;
      z-index: 10000;
      font-weight: 500;
      box-shadow: 0 4px 12px rgba(16, 185, 129, 0.3);
    `;
    notification.textContent = 'Message copied to clipboard!';
    document.body.appendChild(notification);
    
    setTimeout(() => {
      document.body.removeChild(notification);
    }, 2000);
  }).catch(err => {
    console.error('Failed to copy text: ', err);
  });
}
