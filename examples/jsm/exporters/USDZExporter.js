import * as fflate from '../libs/fflate.module.js';

class USDZExporter {

	async parse( scene ) {

		const files = {};
		const modelFileName = 'model.usda';

		// model file should be first in USDZ archive so we init it here
		files[ modelFileName ] = null;

		let output = buildHeader();

		const materials = {};
		const textures = {};

		scene.traverseVisible( ( object ) => {

			if ( object.isMesh ) {

				if ( object.material.isMeshStandardMaterial ) {

					const geometry = object.geometry;
					const material = object.material;

					const geometryFileName = 'geometries/Geometry_' + geometry.id + '.usd';

					if ( ! ( geometryFileName in files ) ) {

						const meshObject = buildMeshObject( geometry );
						files[ geometryFileName ] = buildUSDFileAsString( meshObject );

					}

					if ( ! ( material.uuid in materials ) ) {

						materials[ material.uuid ] = material;

					}

					output += buildXform( object, geometry, material );

				} else {

					console.warn( 'THREE.USDZExporter: Unsupported material type (USDZ only supports MeshStandardMaterial)', object );

				}

			}

		} );

		output += buildMaterials( materials, textures );

		files[ modelFileName ] = fflate.strToU8( output );
		output = null;

		for ( const id in textures ) {

			const texture = textures[ id ];
			const color = id.split( '_' )[ 1 ];
			const isRGBA = texture.format === 1023;

			const canvas = textureToCanvas( texture, color );
			const blob = await new Promise( resolve => canvas.toBlob( resolve, isRGBA ? 'image/png' : 'image/jpeg', 1 ) );

			files[ `textures/Texture_${ id }.${ isRGBA ? 'png' : 'jpg' }` ] = new Uint8Array( await blob.arrayBuffer() );

		}

		// 64 byte alignment
		// https://github.com/101arrowz/fflate/issues/39#issuecomment-777263109

		let offset = 0;

		for ( const filename in files ) {

			const file = files[ filename ];
			const headerSize = 34 + filename.length;

			offset += headerSize;

			const offsetMod64 = offset & 63;

			if ( offsetMod64 !== 4 ) {

				const padLength = 64 - offsetMod64;
				const padding = new Uint8Array( padLength );

				files[ filename ] = [ file, { extra: { 12345: padding } } ];

			}

			offset = file.length;

		}

		return fflate.zipSync( files, { level: 0 } );

	}

}

function textureToCanvas( texture, color ) {
	const image = texture.image;

	const scale = 1024 / Math.max( image.width, image.height );
	const canvas = document.createElement( 'canvas' );
	canvas.width = image.width * Math.min( 1, scale );
	canvas.height = image.height * Math.min( 1, scale );

	if ( ( typeof HTMLImageElement !== 'undefined' && image instanceof HTMLImageElement ) ||
		( typeof HTMLCanvasElement !== 'undefined' && image instanceof HTMLCanvasElement ) ||
		( typeof OffscreenCanvas !== 'undefined' && image instanceof OffscreenCanvas ) ||
		( typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap ) ) {

		const context = canvas.getContext( '2d' );
		context.drawImage( image, 0, 0, canvas.width, canvas.height );

		if ( color !== undefined ) {

			const hex = parseInt( color, 16 );

			const r = ( hex >> 16 & 255 ) / 255;
			const g = ( hex >> 8 & 255 ) / 255;
			const b = ( hex & 255 ) / 255;

			const imagedata = context.getImageData( 0, 0, canvas.width, canvas.height );
			const data = imagedata.data;

			for ( let i = 0; i < data.length; i += 4 ) {

				data[ i + 0 ] = data[ i + 0 ] * r;
				data[ i + 1 ] = data[ i + 1 ] * g;
				data[ i + 2 ] = data[ i + 2 ] * b;

			}

			context.putImageData( imagedata, 0, 0 );
		}

	} else {
		const gl = canvas.getContext( 'webgl' );

		var vertShaderSource = [
				'precision highp float;',
				'attribute vec2 position;',
				'varying vec2 texCoord;',
				'void main( void ) {',
				'	texCoord = ( position * vec2( 1.0, -1.0 ) + vec2( 1.0, 1.0 ) ) * 0.5;',
				'	gl_Position = vec4( position, 0.0, 1.0 );',
				'}'
		].join( '\n' );

		const vertShader = gl.createShader( gl.VERTEX_SHADER );
		gl.shaderSource( vertShader, vertShaderSource );
		gl.compileShader( vertShader );
		if ( !gl.getShaderParameter( vertShader, gl.COMPILE_STATUS ) ) {
			console.log( gl.getShaderInfoLog( vertShader ) );
			return;
		}

		const fragShaderSource = [
				'precision highp float;',
				'varying vec2 texCoord;',
				'uniform sampler2D tex;',
				'uniform lowp vec4 color;',
				'void main( void ) {',
				'	gl_FragColor = texture2D( tex, texCoord ) * color;',
				'}'
		].join( '\n' );

		const fragShader = gl.createShader( gl.FRAGMENT_SHADER );
		gl.shaderSource( fragShader, fragShaderSource );
		gl.compileShader( fragShader );
		if ( !gl.getShaderParameter( fragShader, gl.COMPILE_STATUS ) ) {
			console.log( gl.getShaderInfoLog( fragShader ) );
			return;
		}

		const shaderProgram = gl.createProgram();
		gl.attachShader( shaderProgram, vertShader );
		gl.attachShader( shaderProgram, fragShader );
		gl.linkProgram( shaderProgram );

		if ( !gl.getProgramParameter( shaderProgram, gl.LINK_STATUS ) ) {
			console.log( 'Could not initialise shaders');
			return;
		}

		gl.useProgram( shaderProgram );

		const vertexPositionAttribute = gl.getAttribLocation( shaderProgram, 'position' );
		gl.enableVertexAttribArray( vertexPositionAttribute );

		const triangleVertexPositionBuffer = gl.createBuffer();
		gl.bindBuffer( gl.ARRAY_BUFFER, triangleVertexPositionBuffer );
		const vertices = [
				-1.0, -1.0,
				3.0, -1.0,
				-1.0, 3.0,
		];
		gl.bufferData( gl.ARRAY_BUFFER, new Float32Array( vertices ), gl.STATIC_DRAW );

		const tex = gl.createTexture();
		gl.bindTexture( gl.TEXTURE_2D, tex );
		gl.texParameteri( gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR );
		gl.texParameteri( gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR );
		// We don't care exactly which compression types are available,
		// because `texture.format` is guaranteed to be one of them,
		// BUT we still need to trigger the extension loading via `gl.getExtension`!
		[
			'WEBGL_compressed_texture_s3tc',
			'WEBGL_compressed_texture_s3tc_srgb',
			'WEBGL_compressed_texture_etc',
			'WEBGL_compressed_texture_pvrtc',
			'WEBGL_compressed_texture_etc1',
			'WEBGL_compressed_texture_astc',
			'EXT_texture_compression_bptc',
			'EXT_texture_compression_rgtc',
		].forEach( e => gl.getExtension( e ) );
		gl.compressedTexImage2D( gl.TEXTURE_2D, 0, texture.format, image.width, image.height, 0, texture.mipmaps[ 0 ].data );

		gl.clearColor( 0.0, 0.0, 0.0, 1.0 );
		gl.disable( gl.DEPTH_TEST );
		gl.viewport( 0, 0, canvas.width, canvas.height );
		gl.activeTexture( gl.TEXTURE0 );
		gl.bindTexture( gl.TEXTURE_2D, tex );
		gl.uniform1i( gl.getUniformLocation( shaderProgram, 'tex' ), 0 );

		const colorUniform = gl.getUniformLocation( shaderProgram, 'color');
		if ( color !== undefined ) {
			const hex = parseInt( color, 16 );
			const r = ( hex >> 16 & 255 ) / 255;
			const g = ( hex >> 8 & 255 ) / 255;
			const b = ( hex & 255 ) / 255;
			gl.uniform4f( colorUniform, r, g, b, 1 );
		} else {
			gl.uniform4f( colorUniform, 1, 1, 1, 1 );
		}
		gl.bindBuffer( gl.ARRAY_BUFFER, triangleVertexPositionBuffer );
		gl.vertexAttribPointer( vertexPositionAttribute, 2, gl.FLOAT, false, 0, 0 );
		gl.drawArrays( gl.TRIANGLES, 0, 3 );
	}

	return canvas;
}

//

const PRECISION = 7;

function buildHeader() {

	return `#usda 1.0
(
    customLayerData = {
        string creator = "Three.js USDZExporter"
    }
    metersPerUnit = 1
    upAxis = "Y"
)

`;

}

function buildUSDFileAsString( dataToInsert ) {

	let output = buildHeader();
	output += dataToInsert;
	return fflate.strToU8( output );

}

// Xform

function buildXform( object, geometry, material ) {

	const name = 'Object_' + object.id;
	const transform = buildMatrix( object.matrixWorld );

	if ( object.matrixWorld.determinant() < 0 ) {

		console.warn( 'THREE.USDZExporter: USDZ does not support negative scales', object );

	}

	return `def Xform "${ name }" (
    prepend references = @./geometries/Geometry_${ geometry.id }.usd@</Geometry>
)
{
    matrix4d xformOp:transform = ${ transform }
    uniform token[] xformOpOrder = ["xformOp:transform"]

    rel material:binding = </Materials/Material_${ material.id }>
}

`;

}

function buildMatrix( matrix ) {

	const array = matrix.elements;

	return `( ${ buildMatrixRow( array, 0 ) }, ${ buildMatrixRow( array, 4 ) }, ${ buildMatrixRow( array, 8 ) }, ${ buildMatrixRow( array, 12 ) } )`;

}

function buildMatrixRow( array, offset ) {

	return `(${ array[ offset + 0 ] }, ${ array[ offset + 1 ] }, ${ array[ offset + 2 ] }, ${ array[ offset + 3 ] })`;

}

// Mesh

function buildMeshObject( geometry ) {

	const mesh = buildMesh( geometry );
	return `
def "Geometry"
{
  ${mesh}
}
`;

}

function buildMesh( geometry ) {

	const name = 'Geometry';
	const attributes = geometry.attributes;
	const count = attributes.position.count;

	return `
    def Mesh "${ name }"
    {
        int[] faceVertexCounts = [${ buildMeshVertexCount( geometry ) }]
        int[] faceVertexIndices = [${ buildMeshVertexIndices( geometry ) }]
        normal3f[] normals = [${ buildVector3Array( attributes.normal, count )}] (
            interpolation = "vertex"
        )
        point3f[] points = [${ buildVector3Array( attributes.position, count )}]
        float2[] primvars:st = [${ buildVector2Array( attributes.uv, count )}] (
            interpolation = "vertex"
        )
        uniform token subdivisionScheme = "none"
    }
`;

}

function buildMeshVertexCount( geometry ) {

	const count = geometry.index !== null ? geometry.index.count : geometry.attributes.position.count;

	return Array( count / 3 ).fill( 3 ).join( ', ' );

}

function buildMeshVertexIndices( geometry ) {

	const index = geometry.index;
	const array = [];

	if ( index !== null ) {

		for ( let i = 0; i < index.count; i ++ ) {

			array.push( index.getX( i ) );

		}

	} else {

		const length = geometry.attributes.position.count;

		for ( let i = 0; i < length; i ++ ) {

			array.push( i );

		}

	}

	return array.join( ', ' );

}

function buildVector3Array( attribute, count ) {

	if ( attribute === undefined ) {

		console.warn( 'USDZExporter: Normals missing.' );
		return Array( count ).fill( '(0, 0, 0)' ).join( ', ' );

	}

	const array = [];

	for ( let i = 0; i < attribute.count; i ++ ) {

		const x = attribute.getX( i );
		const y = attribute.getY( i );
		const z = attribute.getZ( i );

		array.push( `(${ x.toPrecision( PRECISION ) }, ${ y.toPrecision( PRECISION ) }, ${ z.toPrecision( PRECISION ) })` );

	}

	return array.join( ', ' );

}

function buildVector2Array( attribute, count ) {

	if ( attribute === undefined ) {

		console.warn( 'USDZExporter: UVs missing.' );
		return Array( count ).fill( '(0, 0)' ).join( ', ' );

	}

	const array = [];

	for ( let i = 0; i < attribute.count; i ++ ) {

		const x = attribute.getX( i );
		const y = attribute.getY( i );

		array.push( `(${ x.toPrecision( PRECISION ) }, ${ 1 - y.toPrecision( PRECISION ) })` );

	}

	return array.join( ', ' );

}

// Materials

function buildMaterials( materials, textures ) {

	const array = [];

	for ( const uuid in materials ) {

		const material = materials[ uuid ];

		array.push( buildMaterial( material, textures ) );

	}

	return `def "Materials"
{
${ array.join( '' ) }
}

`;

}

function buildMaterial( material, textures ) {

	// https://graphics.pixar.com/usd/docs/UsdPreviewSurface-Proposal.html

	const pad = '            ';
	const inputs = [];
	const samplers = [];

	function buildTexture( texture, mapType, color ) {

		const id = texture.id + ( color ? '_' + color.getHexString() : '' );
		const isRGBA = texture.format === 1023;

		textures[ id ] = texture;

		return `
        def Shader "Transform2d_${ mapType }" (
            sdrMetadata = {
                string role = "math"
            }
        )
        {
            uniform token info:id = "UsdTransform2d"
            float2 inputs:in.connect = </Materials/Material_${ material.id }/uvReader_st.outputs:result>
            float2 inputs:scale = ${ buildVector2( texture.repeat ) }
            float2 inputs:translation = ${ buildVector2( texture.offset ) }
            float2 outputs:result
        }

        def Shader "Texture_${ texture.id }_${ mapType }"
        {
            uniform token info:id = "UsdUVTexture"
            asset inputs:file = @textures/Texture_${ id }.${ isRGBA ? 'png' : 'jpg' }@
            float2 inputs:st.connect = </Materials/Material_${ material.id }/Transform2d_${ mapType }.outputs:result>
            token inputs:wrapS = "repeat"
            token inputs:wrapT = "repeat"
            float outputs:r
            float outputs:g
            float outputs:b
            float3 outputs:rgb
            ${ material.transparent || material.alphaTest > 0.0 ? 'float outputs:a' : '' }
        }`;

	}

	if ( material.map !== null ) {

		inputs.push( `${ pad }color3f inputs:diffuseColor.connect = </Materials/Material_${ material.id }/Texture_${ material.map.id }_diffuse.outputs:rgb>` );

		if ( material.transparent ) {

			inputs.push( `${ pad }float inputs:opacity.connect = </Materials/Material_${ material.id }/Texture_${ material.map.id }_diffuse.outputs:a>` );

		} else if ( material.alphaTest > 0.0 ) {

			inputs.push( `${ pad }float inputs:opacity.connect = </Materials/Material_${ material.id }/Texture_${ material.map.id }_diffuse.outputs:a>` );
			inputs.push( `${ pad }float inputs:opacityThreshold = ${material.alphaTest}` );

		}

		samplers.push( buildTexture( material.map, 'diffuse', material.color ) );

	} else {

		inputs.push( `${ pad }color3f inputs:diffuseColor = ${ buildColor( material.color ) }` );

	}

	if ( material.emissiveMap !== null ) {

		inputs.push( `${ pad }color3f inputs:emissiveColor.connect = </Materials/Material_${ material.id }/Texture_${ material.emissiveMap.id }_emissive.outputs:rgb>` );

		samplers.push( buildTexture( material.emissiveMap, 'emissive' ) );

	} else if ( material.emissive.getHex() > 0 ) {

		inputs.push( `${ pad }color3f inputs:emissiveColor = ${ buildColor( material.emissive ) }` );

	}

	if ( material.normalMap !== null ) {

		inputs.push( `${ pad }normal3f inputs:normal.connect = </Materials/Material_${ material.id }/Texture_${ material.normalMap.id }_normal.outputs:rgb>` );

		samplers.push( buildTexture( material.normalMap, 'normal' ) );

	}

	if ( material.aoMap !== null ) {

		inputs.push( `${ pad }float inputs:occlusion.connect = </Materials/Material_${ material.id }/Texture_${ material.aoMap.id }_occlusion.outputs:r>` );

		samplers.push( buildTexture( material.aoMap, 'occlusion' ) );

	}

	if ( material.roughnessMap !== null && material.roughness === 1 ) {

		inputs.push( `${ pad }float inputs:roughness.connect = </Materials/Material_${ material.id }/Texture_${ material.roughnessMap.id }_roughness.outputs:g>` );

		samplers.push( buildTexture( material.roughnessMap, 'roughness' ) );

	} else {

		inputs.push( `${ pad }float inputs:roughness = ${ material.roughness }` );

	}

	if ( material.metalnessMap !== null && material.metalness === 1 ) {

		inputs.push( `${ pad }float inputs:metallic.connect = </Materials/Material_${ material.id }/Texture_${ material.metalnessMap.id }_metallic.outputs:b>` );

		samplers.push( buildTexture( material.metalnessMap, 'metallic' ) );

	} else {

		inputs.push( `${ pad }float inputs:metallic = ${ material.metalness }` );

	}

	if ( material.alphaMap !== null ) {

		inputs.push( `${pad}float inputs:opacity.connect = </Materials/Material_${material.id}/Texture_${material.alphaMap.id}_opacity.outputs:r>` );
		inputs.push( `${pad}float inputs:opacityThreshold = 0.0001` );

		samplers.push( buildTexture( material.alphaMap, 'opacity' ) );

	} else {

		inputs.push( `${pad}float inputs:opacity = ${material.opacity}` );

	}

	if ( material.isMeshPhysicalMaterial ) {

		inputs.push( `${ pad }float inputs:clearcoat = ${ material.clearcoat }` );
		inputs.push( `${ pad }float inputs:clearcoatRoughness = ${ material.clearcoatRoughness }` );
		inputs.push( `${ pad }float inputs:ior = ${ material.ior }` );

	}

	return `
    def Material "Material_${ material.id }"
    {
        def Shader "PreviewSurface"
        {
            uniform token info:id = "UsdPreviewSurface"
${ inputs.join( '\n' ) }
            int inputs:useSpecularWorkflow = 0
            token outputs:surface
        }

        token outputs:surface.connect = </Materials/Material_${ material.id }/PreviewSurface.outputs:surface>
        token inputs:frame:stPrimvarName = "st"

        def Shader "uvReader_st"
        {
            uniform token info:id = "UsdPrimvarReader_float2"
            token inputs:varname.connect = </Materials/Material_${ material.id }.inputs:frame:stPrimvarName>
            float2 inputs:fallback = (0.0, 0.0)
            float2 outputs:result
        }

${ samplers.join( '\n' ) }

    }
`;

}

function buildColor( color ) {

	return `(${ color.r }, ${ color.g }, ${ color.b })`;

}

function buildVector2( vector ) {

	return `(${ vector.x }, ${ vector.y })`;

}

export { USDZExporter };
